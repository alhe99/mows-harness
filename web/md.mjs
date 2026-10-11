// md.mjs — the agent chat's markdown: marked with the guards moved verbatim from the /ui app's views/chat.mjs (safeHref,
// renderer.html, renderer.link/image, tokenizer.tag, renderer.code), renderPartial, reconcile, and block-level memoisation for
// the streaming buffer (renderBlocks, at the end). A chunk of its own (build.mjs names it `marked`, K-02): chat.mjs imports it
// lazily, so the agent route closure does not carry marked. scripts/chat-view-check.mjs imports renderPartial and reconcile from
// here, so the gate and the view exercise the same functions (K-26).
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


// ---------- block-level memoisation (ARCHITECTURE.md section 5; ledger A-08) ----------------------
//
// The live buffer grows by a token at a time and the whole reply used to be re-parsed per delta. Here the buffer is split on
// blank lines; a block that a blank line has closed cannot change again, so its HTML is cached by its text and only the open
// tail (the last block) is parsed per delta. Every block goes through renderPartial, so every guard above applies to each.
//
// A blank line is a boundary only where cutting there cannot change what marked would have made of the whole text:
//   - never inside a fence (``` or ~~~ at the start of a line opens and closes one);
//   - never when the next line is indented or opens a list item, a quote or a table row, which continue the block above;
//   - never at all when the text holds a construct whose extent marked decides across blank lines, or that renderPartial judges over
//     the whole buffer: a reference definition, an HTML block that is not ended by a blank line (<pre>, <script>, <style>,
//     <textarea>, <!--), a ~~~ fence, or a ``` run that is not at the start of a line (renderPartial pads on the parity of every
//     run, so the parity of one block is not the parity of the buffer). Those texts are parsed whole.
const WHOLE = /^ {0,3}\[[^\]\n]+\]:|<(?:pre|script|style|textarea)\b|<!--|^ {0,3}~~~/im;
const runs = (t, re) => (t.match(re) || []).length;
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const CLOSER = /^ {0,3}(?:`{3,}|~{3,})\s*$/;
const CONTINUES = /^(?:\s|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|>|\|)/;
const closed = new Map(); // block text -> rendered HTML
export function splitBlocks(text) {
  const lines = String(text).split('\n'), out = [];
  let cur = [], fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (FENCE.test(l)) {
      if (!fenced) fenced = true;
      else if (CLOSER.test(l)) fenced = false;
      else return null; // an opener-looking line inside a fence: renderPartial's parity and marked disagree about it, so do not guess
    }
    cur.push(l);
    if (fenced || l.trim()) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && !CONTINUES.test(lines[j])) { out.push(cur.join('\n')); cur = []; i = j - 1; }
  }
  out.push(cur.join('\n'));
  return out;
}
/** splitBlocks(text) is null when the fences cannot be told apart safely. What renderPartial(text) makes of the whole buffer, parsing only blocks not seen before. `open`: the last block may still grow, so it is not cached. */
export function renderBlocks(text, open = true) {
  if (WHOLE.test(text) || runs(text, /```/g) !== runs(text, /^ {0,3}```/gm)) return renderPartial(text);
  const blocks = splitBlocks(text);
  if (!blocks) return renderPartial(text);
  const tail = open ? blocks.pop() : null;
  let html = '';
  for (const b of blocks) {
    let h = closed.get(b);
    if (h === undefined) {
      h = renderPartial(b);
      if (closed.size > 400) closed.clear();
      closed.set(b, h);
    }
    html += h;
  }
  return tail == null ? html : html + renderPartial(tail);
}
