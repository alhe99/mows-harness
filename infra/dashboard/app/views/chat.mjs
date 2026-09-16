import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, usd } from '../ui.mjs';
import { getJSON, connect, subscribe } from '../store.mjs';
import { marked, Renderer, Tokenizer } from 'marked';

// ---------- rendering an agent's reply safely (fix round 1) ----------
// An agent's reply is NOT trusted input. Agents read files, fetch pages and summarise other
// systems' output, so a hostile string reaching a reply is an ordinary event. This DOM can start
// agents, stop them, and read every conversation, and the server-rendered /agents/<name> page
// escapes this same text deliberately (see agentRunView's comment) — so rendering it as markdown
// here without a guard would have been a REGRESSION in a property the codebase already had.
//
// The guard overrides the RENDERER, not the input. Pre-escaping the text before marked.parse()
// was tried and is wrong: it double-escapes code blocks (`1 < 2 && 3 > 2` renders as visible
// &lt; and &amp;, the same class of silent corruption as a dropped newline) and does not stop a
// javascript: href at all.
//
// Measured against THIS vendored marked, only two things reach the output unescaped:
//   - the `html` token's raw/text (block AND inline raw HTML; the parser dispatches both here)
//   - a link's / image's href, which cleanUrl() only runs through encodeURI — that stops an
//     attribute breakout, but does nothing about the scheme, so javascript: sails through.
// Everything else the renderer receives is already escaped by the tokenizer: an image's alt
// text, a link's title, and codespan text all arrive as &quot;/&lt;. Escaping those again is
// exactly the double-escaping trap above, so link and image defer to the base renderer once the
// href passes, rather than re-emitting the tag by hand.
const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A scheme ALLOWLIST, not a javascript:-blocklist. Positive matching is what makes this fail
// closed: the bit before the colon must be exactly http, https or mailto, so anything smuggled
// into it — a tab, a NUL, a case change — breaks the match and is refused, rather than having
// to be enumerated as a new bad pattern.
//   - everything up to the first / ? or # is where a scheme can hide, and an & in there means
//     an entity ("&#106;avascript:") that the browser would decode into one, so it is refused
//     outright rather than guessed at;
//   - no scheme at all means a relative URL, which cannot execute, so it stays allowed.
// Anything refused degrades to its own link text, which is visible and inert — never dropped.
//
// trim(), and NOT a control-byte strip, deliberately. A strip was written here first, to
// mirror what a browser does to a URL. Enumerating the cases showed it never refused anything
// trim alone allows — it only ever ALLOWED MORE (it turns a tab-interrupted "ht<TAB>tps://x"
// into a live https link), which is the one direction a security predicate must not move in.
// With a positive allowlist the normalisation buys nothing and can only loosen, so it is gone.
function safeHref(href) {
  const h = String(href ?? '').trim();
  // Protocol-relative ("//evil.example") and UNC-ish (\\evil) destinations have an EMPTY
  // head, so a plain no-scheme test waves them through as if they were relative. They are not:
  // they are off-site navigation on click, from a dashboard whose whole subject is this box.
  // Refused (review L1).
  if (/^[/\\]{2}/.test(h)) return false;
  const head = h.split(/[/?#]/, 1)[0];
  if (/[&%]/.test(head)) return false;
  const colon = head.indexOf(':');
  if (colon === -1) return true;
  return /^(?:https?|mailto)$/i.test(head.slice(0, colon));
}

// THE SECOND RAW PATH, and the one that made fix round 1 incomplete (review C1).
//
// renderer.html is not the only way unescaped content reaches the output. marked's INLINE tag
// tokenizer (vendor/marked.mjs:704) sets lexer.state.inRawBlock when it sees an open tag matching
// <(pre|code|kbd|script), and inlineText() (vendor:958) then stops escaping:
//     if (this.lexer.state.inRawBlock) { text = cap[0]; } else { text = escape$1(cap[0]); }
// Two things turn that into a stored-XSS hole rather than a curiosity:
//   - the flag persists for the REST OF THE MESSAGE. Lexer.lex() drains one shared `state` across
//     blockTokens and inlineQueue, so an unclosed inline <code> in paragraph 1 disables escaping
//     in paragraph 2, in list items, in blockquotes and in table cells.
//   - the payload that then rides through need only be a shape marked's tag regex REJECTS and a
//     browser ACCEPTS — "<img/src=x onerror=…>". It never becomes an `html` token at all, so
//     neither renderer.html nor safeHref is ever consulted.
// The trigger is an agent writing "use the <script> tag" without backticks. That is a sentence
// about HTML, not an exotic input.
//
// The fix is at the WRITER, not the reader: clear the flag after every tag token, so it is never
// true and inlineText escapes unconditionally. Deliberately the writer and not an inlineText
// override — inlineText is the only reader in this vendored copy (the token field set at
// vendor:714 is never read back), but holding the flag permanently false stays correct if a
// future marked adds a second reader, whereas patching one reader would not.
// NOT fixed by overriding renderer.text: Parser.parse's `case 'text'` re-wraps ALREADY-RENDERED
// html in a synthetic token and emits it through renderer.text, so escaping there would
// double-escape every top-level text block (review C1).
const tokenizer = new Tokenizer();
const baseTag = Tokenizer.prototype.tag;
tokenizer.tag = function (src) {
  const token = baseTag.call(this, src);
  if (this.lexer) this.lexer.state.inRawBlock = false;
  if (token) token.inRawBlock = false;
  return token;
};

const renderer = new Renderer();
renderer.html = ({ raw, text }) => escapeHtml(raw ?? text ?? '');
renderer.link = function (token) {
  return safeHref(token.href) ? Renderer.prototype.link.call(this, token) : this.parser.parseInline(token.tokens);
};
renderer.image = function (token) {
  // token.text is the alt text, already escaped by the tokenizer — returned as-is on refusal.
  return safeHref(token.href) ? Renderer.prototype.image.call(this, token) : (token.text || '');
};

// Mid-stream the buffer routinely holds a fence that has opened and not yet closed. Close it for
// DISPLAY only; the buffer is untouched.
//
// What this actually buys, measured against the vendored marked rather than assumed: for a
// trailing BLOCK fence it buys nothing — marked already runs an unclosed fence to the end of the
// document (CommonMark), and padded vs unpadded output is byte-identical across all 59 prefixes
// of a realistic fenced reply. Where it does earn its place is a stray inline ``` run sitting in
// ordinary prose: unpadded, 41 of that string's 50 prefixes render with the backticks showing;
// padded, none do. The parity test is load-bearing — padding an already-balanced buffer invents
// a code block that is not there.
// Exported so scripts/chat-view-check.mjs exercises THIS function and not a copy of it, the same
// reason Task 6 pulled wireChatStream() out of lite.mjs into its own module.
export function renderPartial(text) {
  const fences = (text.match(/```/g) || []).length;
  try {
    return marked.parse(fences % 2 ? text + '\n```' : text, { async: false, renderer, tokenizer });
  } catch {
    // marked is called with `silent` unset, so Parser.parse's default case can throw. This runs
    // DURING render and the SPA has no error boundary, so an unhandled throw here blanks the
    // whole view rather than one bubble. Escaped plain text is a poor render; a blank dashboard
    // mid-turn is a worse one (review L6).
    return '<p>' + escapeHtml(text) + '</p>';
  }
}

export function Chat({ name, runs }) {
  const [turns, setTurns] = useState([]);
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const boxRef = useRef(null), taRef = useRef(null), turnRef = useRef(0), liveRef = useRef('');
  const chatable = (runs || []).some(r => r.state === 'done');

  useEffect(() => {
    getJSON(`/api/agents/${name}/chat`).then(d => setTurns(d.turns)).catch(() => {});
    connect(['agents', `chat:${name}`]);
    const offA = subscribe('chat', d => {
      if (d.agent !== name) return;
      // A delta from a newer turn replaces the buffer rather than appending to it. This is
      // the same reset-on-mismatch rule the server's chatBuf uses, and it is what makes
      // turnRef current before any `chatend` is compared against it.
      if (d.turn !== turnRef.current) { turnRef.current = d.turn; liveRef.current = ''; }
      // liveRef mirrors `live` so the chatend handler below can salvage the finished reply
      // without reading it back out of a state updater.
      liveRef.current += d.delta;
      setBusy(true); setErr(''); setLive(liveRef.current);
    });
    const offB = subscribe('chatend', d => {
      if (d.agent !== name) return;
      // The server is first-end-wins; the client is newest-turn-wins. Both are needed. When a
      // turn's child dies, the server sends a `closed:true` fallback for THAT turn, which can
      // arrive after a newer turn has already started streaming — clearing `live`
      // unconditionally would wipe the in-flight reply the user is watching (Task 6 review, R3).
      if (d.turn && d.turn < turnRef.current) return;
      setBusy(false);
      // `live` is held until the refetched transcript is actually in hand (fix round 1). Clearing
      // it here and letting the refetch land whenever it lands left the finished reply on screen
      // NOWHERE for one round trip — measured at 1,498 ms with a 1,500 ms refetch, i.e. exactly
      // the RTT. On the phone this view is built for that is the user watching their answer get
      // deleted and then come back.
      // d.turn, not turnRef.current: turnRef is the turn the client last saw a DELTA for, which
      // differs from the turn that ended whenever an end arrives for a turn that produced none
      // (review L2). d.turn is always present in practice — agentAction sets it to Date.now() —
      // so the fallback is belt and braces.
      const endedTurn = d.turn || turnRef.current, salvage = liveRef.current;
      // turnRef can advance while the refetch is in flight, so newest-turn-wins has to survive
      // the await too: only the turn that ended may clear the buffer.
      const settle = () => { if (turnRef.current === endedTurn) { liveRef.current = ''; setLive(''); } };
      // The reply is only safe to stop showing once it is actually IN the transcript that came
      // back. A refetch can SUCCEED and still not contain it: chatEnd's `closed:true` fallback
      // fires for a child that died, and a child killed before mows-agent's own append to
      // chat.jsonl leaves exactly that state — transcript fetched fine, finished turn missing,
      // reply deleted off the screen with no message. The happy path is safe only because
      // cmd_chat appends the assistant record BEFORE printing the end line, which is a guarantee
      // in a different program and not one this file may lean on (review M1).
      const keep = list => {
        const last = list[list.length - 1];
        return salvage && !(last && last.role === 'assistant')
          ? [...list, { at: new Date().toISOString(), role: 'assistant', text: salvage }]
          : list;
      };
      getJSON(`/api/agents/${name}/chat`)
        .then(x => {
          const list = x.turns || [];
          const kept = turnRef.current === endedTurn ? keep(list) : list;
          setTurns(kept);
          if (kept !== list) setErr('Reply shown above, but it is not in the saved transcript yet.');
          settle();
        })
        .catch(() => {
          // The refetch failed outright, so the transcript will not arrive at all. Same rule:
          // settle the reply in place rather than blanking it or leaving a bubble pulsing
          // "in progress" forever.
          if (turnRef.current === endedTurn && salvage) setTurns(t => keep(t));
          settle();
          setErr('Reply received, but reloading the transcript failed. Reload to confirm it was saved.');
        });
    });
    return () => { offA(); offB(); };
  }, [name]);

  // Safari implements no CSS scroll-anchoring, so this is hand-written on purpose (spec §4).
  // A CSS-only approach would be correct on desktop and wrong on the phone this is built for.
  const onScroll = useCallback(() => {
    const el = boxRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);
  useEffect(() => {
    if (atBottom && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [turns, live, atBottom]);

  // Keep the composer above the on-screen keyboard. 100vh does not account for it.
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const fit = () => document.documentElement.style.setProperty('--kb', (window.innerHeight - vv.height - vv.offsetTop) + 'px');
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
  }, []);

  const send = async e => {
    e.preventDefault();
    const msg = taRef.current.value.trim(); if (!msg) return;
    taRef.current.value = '';
    // Kept by reference so the optimistic bubble can be withdrawn again if the POST never lands.
    const pending = { at: new Date().toISOString(), role: 'user', text: msg };
    setTurns(t => [...t, pending]);
    setBusy(true); setErr(''); setAtBottom(true);
    const body = new URLSearchParams({ name, back: `/ui/agents/${name}`, msg });
    try {
      const r = await fetch('/a/agent-chat', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      // A non-2xx is as fatal as a thrown fetch and was previously indistinguishable from
      // success: agentAction answers 400 on an empty message, 403 on a bad origin and 409 when
      // the agent unit is not installed, and every one of them used to wedge the composer.
      if (!r.ok) throw new Error((await r.text().catch(() => '')).trim().slice(0, 160) || `HTTP ${r.status}`);
    } catch (ex) {
      // No turn started, so no `chatend` is coming to clear `busy` — without this the composer
      // stayed disabled on "…" and "Thinking…" never cleared, recoverable only by reloading
      // (fix round 1). The typed text goes back in the box rather than being lost with it.
      setBusy(false);
      setTurns(t => t.filter(x => x !== pending));
      setErr(`Could not send: ${ex.message || ex}`);
      if (!taRef.current.value) taRef.current.value = msg;
    }
  };

  if (!chatable) return html`<p class="muted">Chat resumes a finished run's session. Run this agent once first.</p>`;
  return html`<div class="chat">
    <div class="chatbox" ref=${boxRef} onScroll=${onScroll}>
      ${turns.map((t, i) => html`<div class="m ${t.role === 'user' ? 'me' : 'claude'}" key=${i}>
        <div class="mh"><b>${t.role === 'user' ? 'you' : name}</b>
          <span class="muted">${(t.at || '').slice(11, 19)}${t.cost_usd ? ' · ' + usd(t.cost_usd) : ''}</span></div>
        <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(t.text || '') }} /></div>`)}
      ${live && html`<div class="m claude streaming">
        <div class="mh"><b>${name}</b> <span class="muted">…</span></div>
        <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(live) }} /></div>`}
      ${busy && !live && html`<p class="muted">Thinking…</p>`}
    </div>
    ${!atBottom && html`<button class="jump" onClick=${() => setAtBottom(true)}>Jump to latest</button>`}
    ${err && html`<p class="cherr" role="alert">${err}</p>`}
    <form class="chatf" onSubmit=${send}>
      <textarea ref=${taRef} rows="2" placeholder=${`Ask ${name} about its last run…`}
        onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) send(e); }} required></textarea>
      <button disabled=${busy}>${busy ? '…' : 'Send'}</button>
    </form>
  </div>`;
}
