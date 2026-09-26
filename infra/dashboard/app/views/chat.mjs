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
  // The lexer-state clear is DELIBERATELY UNCONDITIONAL — outside `if (token)`, and guarded only
  // on `this.lexer` existing. tag() is consulted at every inline position, so clearing here means
  // the flag is false before every inline text node, not merely wherever this marked happens to
  // set it. Tucking it inside `if (token && this.lexer)` is the obvious tidy-up and is
  // behaviourally identical against THIS marked (only tag() sets the flag, in the same call the
  // clear then undoes), so no assertion can tell the two apart and the check stays 63 green
  // either way. The difference only shows up against a future marked that sets the flag
  // somewhere else — which is the whole point. Re-review R3: do not simplify this.
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
// The agent's memory write-back is a ```mows-memory fence at the end of most replies, and it
// was most of every message on screen — the same text the Memory card already shows. It is
// collapsed to a one-line disclosure rather than removed: what the agent chose to remember must
// stay one click away in the transcript, because that is where a wrong belief is first noticed.
// The fence body still goes through the BASE code renderer, so the escaping the rest of this
// file was built to guarantee is untouched; only the wrapper is new, and its one dynamic value
// is a line count.
renderer.code = function (token) {
  const inner = Renderer.prototype.code.call(this, token);
  if (!/^mows-memory\b/.test(token.lang || '')) return inner;
  const lines = (token.text || '').split('\n').filter(l => l.trim()).length;
  return `<details class="memupd"><summary>memory updated · ${lines} line${lines === 1 ? '' : 's'}</summary>${inner}</details>`;
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

// ---------- reconciling the optimistic view with the saved transcript ------------------------
//
// A turn ends, the client refetches chat.jsonl, and the refetched list REPLACES what is on screen.
// Everything the client added optimistically and the transcript does not have is therefore
// deleted, silently, unless this function puts it back.
//
// Round 1 applied that reasoning to the agent's reply (review M1) and not to the operator's own
// message, and the gap was measured in a real browser in Task 9: submit fires, a `you` bubble
// appears, and 21 ms later it is gone with `.cherr` still null. The operator watched the system
// eat their question and say nothing.
//
// WHEN IT HAPPENS, which is the part that decides how loud to be: mows-agent's cmd_chat appends
// the user record BEFORE spawning claude, so the happy path is safe. Every EARLY EXIT before that
// append is not — no completed run to resume, a lint refusal, a bad name, the unit missing. So the
// message vanishes exactly in the cases where something has already gone wrong and the operator
// most needs to be told. Restoring the bubble is the smaller half of the fix; saying so is the
// larger one, and the caller does both.
//
// Exported for the same reason renderPartial is: scripts/chat-view-check.mjs exercises THIS
// function rather than a copy of its rules, which is how the rules and their gate stay in step.
export function reconcile(list, pendingUsers, salvage) {
  const turns = Array.isArray(list) ? list : [];
  const txt = t => String(t && t.text != null ? t.text : '');
  // The user's own messages first, matched by COUNT AGAINST A BASELINE rather than by membership.
  //
  // Membership ("is this text anywhere in the transcript?") calls a repeated question saved because
  // an EARLIER one was, and deletes it. Round 1's comment claimed to have fixed that and the code
  // did not: it consumed matches from a pool, which handles two pendings in flight at once and not
  // the case the comment actually described — ask "status?", have it saved, ask "status?" again,
  // and the second is absorbed by the first one's record (review F1). A comment that describes a
  // guarantee the code does not provide is worse than no comment, because the next reader stops
  // checking.
  //
  // `baseline` is how many user turns already carried this exact text when the message was sent,
  // counting only transcript-backed ones. A pending is saved only once the refetched count EXCEEDS
  // that. No clock is involved: a client `at` and a server `at` cannot be compared safely, and
  // ordering by them would be a guess dressed as a rule.
  //
  // Pendings sharing one text are resolved in send order, and by construction share one baseline —
  // a later message is only given a higher baseline once the earlier one's record has actually
  // landed, at which point it is no longer pending. So `count - baseline` is exactly how many of
  // them the transcript now accounts for.
  const countOf = s => turns.reduce((n, t) => n + (t && t.role === 'user' && txt(t) === s ? 1 : 0), 0);
  const groups = new Map();
  for (const p of pendingUsers || []) {
    const s = txt(p);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(p);
  }
  const saved = new Set();
  for (const [s, ps] of groups) {
    // A MISSING BASELINE IS A CALLER BUG, and the two ways of guessing past it are not symmetric.
    // This defaulted to 0, which silently reinstates the round-1 semantics: a repeated question is
    // matched by the earlier one's record and DELETED with nothing said. Assuming "not accounted
    // for" instead shows a message that may in fact have been saved, and says so on screen. Only
    // the second is recoverable by the person reading it, and only the second is visible at all —
    // which is what makes this louder than the comment that used to be here (Task 9 fix round 2;
    // the lead's own re-probe hit this fallback and read it as the bug still being present, which
    // is the clearest possible evidence that a silent fallback to old semantics is the wrong one).
    const bases = ps.map(p => (p && Number.isFinite(Number(p.baseline))) ? Number(p.baseline) : null);
    const accounted = bases.includes(null) ? 0
      : Math.max(0, Math.min(ps.length, countOf(s) - Math.min(...bases)));
    for (let i = 0; i < accounted; i++) saved.add(ps[i]);
  }
  // A pending already reported to the operator is not shown again and not re-reported. Round 1
  // kept it pending forever, so it was re-appended BELOW every later question and its reply, and
  // the alert re-fired each turn describing a failure several turns old (review F2). The transcript
  // is authoritative from the second turn onward; the message has been named once, and the text has
  // been handed back to the composer.
  const missingUsers = [], retired = [];
  for (const p of pendingUsers || []) {
    if (saved.has(p)) continue;
    (p && p.reported ? retired : missingUsers).push(p);
  }
  let out = missingUsers.length ? [...turns, ...missingUsers] : turns;
  // ...then the reply, appended AFTER the question it answers rather than before it.
  //
  // Identity, not position (re-review R5). Asking "is the last entry an assistant turn?" says
  // "present" for a STALE assistant turn left by an earlier turn while this turn's records are
  // absent entirely — the exact silent drop M1 was opened for. So ask the newest assistant turn
  // whether it actually carries what we just watched. `includes` and not `===`: a client that
  // joined mid-turn holds only a SUFFIX of the reply, and exact equality would append that partial
  // as a duplicate beside the complete saved one. A stale turn contains none of it, so it still
  // salvages.
  let salvagedReply = false;
  if (salvage) {
    const newest = [...out].reverse().find(t => t && t.role === 'assistant');
    if (!(newest && String(newest.text || '').includes(salvage))) {
      out = [...out, { at: new Date().toISOString(), role: 'assistant', text: salvage }];
      salvagedReply = true;
    }
  }
  return { turns: out, missingUsers, retired, salvagedReply };
}

// events.log lines are "<ISO8601> <text>". Only some of them earn a divider in the transcript:
// the log records one line per chat turn ("chat turn (streamed): $0.02"), and that cost is
// already printed on the message it belongs to, so rendering all of them would interrupt every
// single message with a restatement of itself. What survives the filter is the run lifecycle and
// the failures, and a memory that was cut or cleared — which is what the comp's one divider is for.
const EV_RE = /^(\d{4}-\d\d-\d\dT[\d:]+(?:[+-][\d:]+|Z))\s+(.+)$/;
const systemEvents = events => (events || [])
  .map(l => EV_RE.exec(l))
  // `memory stored` is per-turn too — the reply above it carries the same fact as a pill —
  // so it joins the filter. `memory truncated` and `memory cleared` stay: those are worth a line.
  .filter(m => m && !/^(chat turn|memory stored)\b/.test(m[2]))
  .map(m => ({ at: m[1], text: m[2] }));

// Turns keep the ORDER THE SERVER GAVE THEM — they are not re-sorted. Sorting a merged list by
// timestamp would put the reconcile logic's optimistic pendings (stamped client-side, at a clock
// this server does not share) at the mercy of clock skew, and message order is the one thing
// this view has already been fixed twice to get right. System events are interleaved around that
// fixed order instead: each one is emitted before the first turn it does not precede.
function feed(turns, events) {
  const left = systemEvents(events);
  const out = [];
  for (const turn of turns) {
    const ts = Date.parse(turn.at || 0);
    while (left.length && Date.parse(left[0].at) <= ts) out.push({ sys: left.shift() });
    out.push({ turn });
  }
  for (const sys of left) out.push({ sys });
  return out;
}

export function Chat({ name, events, tools }) {
  const [turns, setTurns] = useState([]);
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const boxRef = useRef(null), taRef = useRef(null), turnRef = useRef(0), liveRef = useRef('');
  // Messages this client has shown and has not yet seen come back in a refetched transcript.
  // A ref and not state: the chatend handler below is created once per `name` and would
  // otherwise close over the first render's value, which is the bug that makes an optimistic
  // bubble look preserved in testing and vanish in production.
  const pendingRef = useRef([]);

  useEffect(() => {
    // Pendings belong to the agent they were typed at. Today `Chat` unmounts when `name`
    // changes, because AgentDetail blanks its data while refetching — but that is a loading
    // state, not a contract, and the ordinary optimisation of keeping the old data on screen
    // would leak one agent's lost message into another's transcript and warning (review F2).
    pendingRef.current = [];
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
      getJSON(`/api/agents/${name}/chat`)
        .then(x => {
          const list = x.turns || [];
          // newest-turn-wins still governs the REPLY — that is what it was added for (F8/R3) — so a
          // stale end salvages nothing. It must NOT govern the user's own message: that message
          // belongs to whoever typed it, not to the turn whose end happened to arrive, and
          // discarding it because an older turn ended is the very deletion being fixed here.
          const mine = turnRef.current === endedTurn;
          const r = reconcile(list, pendingRef.current, mine ? salvage : '');
          setTurns(r.turns);
          // Anything still missing is now marked reported, so the next turn shows it neither again
          // nor silently — reconcile retires it instead of re-appending it under a later exchange.
          pendingRef.current = r.missingUsers.map(q => ({ ...q, reported: true }));
          if (r.missingUsers.length) {
            // Hand the text back as well as saying so. Only when the composer is empty (the
            // operator may already be typing something else) and only when no reply arrived at
            // all — after a real reply a retry would be a duplicate question, not a recovery.
            const lost = r.missingUsers[r.missingUsers.length - 1];
            const handedBack = !salvage && taRef.current && !taRef.current.value;
            if (handedBack) taRef.current.value = String(lost && lost.text || '');
            // The sentence has to match what actually happens next, or it becomes the "label that
            // lies" shape in the very code written to stop one: the message is shown until the
            // transcript next reloads, and then it is gone.
            setErr('Your message was not saved — the turn ended before the agent recorded it, so it probably never ran. It is shown below until the transcript reloads' +
              (handedBack ? '; the text is back in the composer.' : ' — copy it before sending anything else.'));
          } else if (r.salvagedReply) {
            setErr('Reply shown above, but it is not in the saved transcript yet.');
          }
          settle();
        })
        .catch(() => {
          // The refetch failed outright, so the transcript never arrives and NOTHING can be
          // concluded about what was saved. Settle what is on screen rather than blanking it or
          // leaving a bubble pulsing "in progress" forever, and leave every pending PENDING: a
          // failed fetch is not evidence that a message is missing, and it is not evidence that it
          // is present either. Hence `[]` here — only the reply is salvaged; the pendings are
          // already in `t` and must not be resolved against a list that proves nothing.
          if (turnRef.current === endedTurn && salvage) setTurns(t => reconcile(t, [], salvage).turns);
          settle();
          // Round 1 said "Reply received" on this branch unconditionally, including when no reply
          // had arrived at all — which is exactly the turn-died-early case this round is about
          // (review F11). Say only what is known.
          setErr(salvage
            ? 'Reply received, but reloading the transcript failed. Reload to confirm it was saved.'
            : 'The turn ended and reloading the transcript failed, so this view may be out of date. Reload to see what was saved.');
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
    // (kb-open is set from the composer's focus/blur below, not from here: in the installed PWA iOS
    // pans the page for the keyboard instead of resizing the visual viewport, so this handler
    // measures 0 there and a viewport-based flag never fired.)
    const fit = () => document.documentElement.style.setProperty('--kb', (window.innerHeight - vv.height - vv.offsetTop) + 'px');
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    return () => {
      vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit);
      document.documentElement.classList.remove('kb-open'); // unmounting mid-focus must not leave the bar hidden
    };
  }, []);

  const send = async e => {
    e.preventDefault();
    const msg = taRef.current.value.trim(); if (!msg) return;
    taRef.current.value = '';
    // Kept by reference so the optimistic bubble can be withdrawn again if the POST never lands.
    // How many TRANSCRIPT-BACKED user turns already carry this exact text. Our own optimistic
    // copies are subtracted: they sit in `turns` and are not in the transcript, and counting them
    // would raise the bar so far that a genuinely saved message read as lost. reconcile treats the
    // message as saved only once the refetched count exceeds this, which is what makes a REPEATED
    // question distinguishable from the earlier one that was saved (review F1).
    const sameText = t => t && t.role === 'user' && String(t.text ?? '') === msg;
    const baseline = turns.filter(sameText).length - pendingRef.current.filter(sameText).length;
    const pending = { at: new Date().toISOString(), role: 'user', text: msg, baseline: Math.max(0, baseline) };
    // Also recorded OUTSIDE the turns list, so the refetch that replaces that list wholesale can
    // be asked whether it actually contains this message (see reconcile above).
    pendingRef.current = [...pendingRef.current, pending];
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
      pendingRef.current = pendingRef.current.filter(x => x !== pending);
      setTurns(t => t.filter(x => x !== pending));
      setErr(`Could not send: ${ex.message || ex}`);
      if (!taRef.current.value) taRef.current.value = msg;
    }
  };

  // No completed-run gate (spec 2026-09-19 §2.4): a chat turn no longer resumes a session, so
  // there is nothing a first run has to create before the first question can be asked.
  return html`<div class="chat">
    <div class="chatbox" ref=${boxRef} onScroll=${onScroll}>
      ${feed(turns, events).map((row, i) => row.sys
        ? html`<div class="sysdiv" key=${'s' + i}><span class="sysl"></span>
            <span class="sysb"><i class="sysi" aria-hidden="true"></i>${row.sys.text}
              <span class="muted">${row.sys.at.slice(11, 19)}</span></span>
            <span class="sysl"></span></div>`
        : html`<div class="m ${row.turn.role === 'user' ? 'me' : 'claude'}" key=${i}>
            <span class="mav" aria-hidden="true"></span>
            <div class="mc">
              <div class="mh"><b>${row.turn.role === 'user' ? 'you' : name}</b>
                <span class="muted">${(row.turn.at || '').slice(11, 19)}${row.turn.cost_usd ? ' · ' + usd(row.turn.cost_usd) : ''}</span></div>
              <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(row.turn.text || '') }} /></div></div>`)}
      ${live && html`<div class="m claude streaming">
        <span class="mav" aria-hidden="true"></span>
        <div class="mc">
          <div class="mh"><b>${name}</b> <span class="muted">…</span></div>
          <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(live) }} /></div></div>`}
      ${busy && !live && html`<p class="muted">Thinking…</p>`}
    </div>
    ${!atBottom && html`<button class="jump" onClick=${() => setAtBottom(true)}>Jump to latest</button>`}
    ${err && html`<p class="cherr" role="alert">${err}</p>`}
    <form class="chatf" onSubmit=${send}>
      ${/* A phone-width placeholder that wraps to two lines makes the composer look mid-edit. Read
            once at render; a resize across 500px mid-conversation is not a case worth a listener. */ ''}
      <textarea ref=${taRef} rows="2" placeholder=${matchMedia('(max-width: 500px)').matches ? `Ask ${name}…` : `Ask ${name} to analyze or run commands…`}
        ${/* Focus is the keyboard signal iOS reports everywhere (the installed PWA pans the page for
              the keyboard instead of resizing the visual viewport). html.kb-open hides the phone tab
              bar while set; a class, not a style, for CSP. Cleared on blur — Done, a tap elsewhere,
              or Send, which moves focus to the button. */ ''}
        onFocus=${() => document.documentElement.classList.add('kb-open')}
        onBlur=${() => document.documentElement.classList.remove('kb-open')}
        onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) send(e); }} required></textarea>
      ${/* The label is an aria-label, not a text node: the comp's send control is a 40px circle
            and "Send" does not fit in one. The busy state keeps a visible "…" because a disabled
            control with no text and no icon is indistinguishable from a rendering failure. */ ''}
      <button class="sendb" disabled=${busy} aria-label=${busy ? 'Sending' : 'Send'}>${busy ? '…' : ''}</button>
    </form>
    ${tools && html`<p class="chint">${name} has access to ${tools}.<span class="chint-help"> Use /help for commands.</span></p>`}
  </div>`;
}
