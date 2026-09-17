// Persisted regression check for Task 7's streaming-markdown renderer. Exercises the SAME
// renderPartial() the chat view calls (infra/dashboard/app/views/chat.mjs), not a copy of its
// logic — the precedent set by scripts/chat-stream-utf8-check.mjs, and for the same reason: a
// throwaway copy drifts out of sync with production silently.
//
// chat.mjs is browser code and imports three bare specifiers (preact, preact/hooks, htm) plus
// marked, which the SERVER resolves through the inline import map in uiShellHtml(). Node has no
// import map, so this file reproduces that same mapping with a resolve hook pointed at the very
// files the import map points at — app/vendor/*. Nothing is stubbed: the real vendored marked
// does the rendering here exactly as it does in the browser.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const APP = new URL('../infra/dashboard/app/', pathToFileURL(import.meta.filename));
if (typeof registerHooks !== 'function') {
  console.error('FAIL: node:module.registerHooks is unavailable — this check needs Node >= 22.15');
  process.exit(1);
}
const VENDOR = {
  preact: 'vendor/preact.mjs',
  'preact/hooks': 'vendor/hooks.mjs',
  htm: 'vendor/htm.mjs',
  marked: 'vendor/marked.mjs',
};
registerHooks({
  resolve(specifier, context, next) {
    const rel = VENDOR[specifier];
    if (rel) return { url: new URL(rel, APP).href, shortCircuit: true };
    return next(specifier, context);
  },
});

const { renderPartial, reconcile } = await import(new URL('views/chat.mjs', APP).href);
// The vendored marked itself, to pin the HAZARD the view's tokenizer override neutralises.
const { marked: rawMarked } = await import(new URL('vendor/marked.mjs', APP).href);

let failed = false;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
  if (!cond) { failed = true; if (detail !== undefined) console.log('  got: ' + JSON.stringify(detail)); }
}
// Rendered text as a reader sees it: tags stripped, entities for the characters this file cares
// about decoded. Used to assert on what is VISIBLE, never on the markup that produced it.
const visible = htmlStr => htmlStr
  .replace(/<[^>]*>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ---- what the view must show, and what renderPartial() itself contributes -------------------
// Read this before trusting the three assertions below. The vendored marked ALREADY closes an
// unterminated BLOCK fence on its own — that is CommonMark ("the rest of the document"), and it
// was measured against app/vendor/marked.mjs: over every prefix of a realistic fenced reply, the
// padded and unpadded renderings are byte-identical, 0 differences in 59 prefixes. So these three
// assert a real user-facing property (the code block shows as a code block) but they do NOT
// exercise renderPartial's own fence padding, and they stay green if it is deleted. The check
// that does exercise it is the inline-run one below. Kept anyway: they are what actually has to
// be true on screen, and they are the tripwire if the vendored renderer is ever swapped for one
// that does not auto-close.
const openFence = 'Checking the disk:\n\n```bash\ndf -h';
const openOut = renderPartial(openFence);
check('[marked, not renderPartial] an unterminated block fence renders as a code block',
  /<pre>[\s\S]*<code/.test(openOut), openOut);
check('[marked, not renderPartial] an unterminated block fence shows no literal backticks',
  !visible(openOut).includes('```'), visible(openOut));
// Asserted on where the text LANDED, not merely that it is somewhere on the page: "the page
// contains df -h" is equally true of a build that renders the raw buffer and no markdown at all.
const codeBody = (openOut.match(/<code[^>]*>([\s\S]*?)<\/code>/) || [])[1];
check('[marked, not renderPartial] the code lands INSIDE the code element, not in prose',
  !!codeBody && codeBody.includes('df -h'), codeBody);

// renderPartial's ACTUAL contribution, and the only measured case where padding changes the
// output for the better: a stray triple-backtick run sitting in ordinary prose. Unpadded, 41 of
// this string's 50 prefixes render with the backticks visible; padded, none do. Delete the
// padding and this one goes red.
const inlineRun = 'Inline ``` in prose, then more words';
check('a stray inline fence run shows no literal backticks (this is what the padding buys)',
  !visible(renderPartial(inlineRun)).includes('```'), visible(renderPartial(inlineRun)));

// The padding is for DISPLAY only. Strings are immutable, so "the buffer is untouched" is not
// worth asserting; what IS worth asserting is that the synthetic closing fence never shows up
// as content, and that the next delta appended to the real buffer still renders correctly.
const closed = renderPartial(openFence + '\n```\n\nDone.');
check('the same buffer, once the real closing fence arrives, still renders one code block',
  (closed.match(/<pre>/g) || []).length === 1, closed);
check('text after the closed fence renders as prose', /<p>Done\.<\/p>/.test(closed), closed);

// ---- every prefix of a streamed reply, not just the convenient ones -------------------------
// The real bug class is "some intermediate state renders wrong", so walk EVERY prefix rather
// than the three or four a hand-picked fixture would cover. Both shapes are here on purpose:
// the block-fence reply is the common case (and, per the note above, is marked's doing), the
// inline-run reply is the one that goes red if the padding is removed.
const replies = [
  'Here is the check.\n\n```bash\ndf -h\nfree -m\n```\n\nThat is all, mañana.',
  'You can write ``` to open a fence, then close it the same way.',
];
let worstPrefix = null;
for (const reply of replies) {
  for (let i = 1; i <= reply.length && !worstPrefix; i++) {
    const v = visible(renderPartial(reply.slice(0, i)));
    if (v.includes('```')) worstPrefix = { i, prefix: reply.slice(0, i), visible: v };
  }
}
check('no prefix of a streamed reply ever shows a literal fence', worstPrefix === null, worstPrefix);

// KNOWN GAPS, measured against this vendored marked and deliberately NOT asserted here, because
// asserting them would mean asserting a bug: a fence opened inside a LIST ITEM ("- x with ```y")
// still shows its backticks mid-stream, padded or not; and a three-tick fence nested inside a
// four-tick one renders worse WITH the padding than without (26 of 37 prefixes show backticks
// instead of 22) because the parity count cannot tell the two fence widths apart. Both are
// transient mid-stream states that resolve when the buffer completes, and neither is reachable
// from the fenced-code shape agents actually emit. Recorded so the next person does not have to
// rediscover them.

// ---- paragraph breaks: a delta that is exactly "\n\n" is a real chunk from the API ----------
// Regression: an earlier build of the streaming path dropped every paragraph break, collapsing
// the whole reply into one run-on block.
const paras = renderPartial('First paragraph.\n\nSecond paragraph.');
check('a blank line between two paragraphs produces two <p> elements',
  (paras.match(/<p>/g) || []).length === 2, paras);

// ---- non-ASCII: corrupted accents were shipped to every viewer once on this branch ----------
const accents = 'café mañana Ångström — naïve "quoted" 日本語';
const accentOut = visible(renderPartial(accents));
check('non-ASCII text survives rendering byte-for-byte',
  accentOut.includes('café mañana Ångström') && accentOut.includes('日本語'), accentOut);
check('no U+FFFD replacement character is introduced', !accentOut.includes('\uFFFD'), accentOut);

// ---- fence counting is parity, not presence -------------------------------------------------
// Asserted on STRUCTURE, not on "are there backticks on screen": a balanced buffer that gets
// padded anyway still renders without visible backticks (marked absorbs the spurious fence), so
// a backtick assertion here would be green under exactly the mutation it is meant to catch.
// Counting the code blocks is what actually distinguishes the two.
const threeFences = 'a\n\n```\none\n```\n\n```js\ntwo';
check('an odd fence count (3) yields the two code blocks the buffer describes',
  (renderPartial(threeFences).match(/<pre>/g) || []).length === 2, renderPartial(threeFences));
const fourFences = threeFences + '\n```';
check('an even fence count (4) is left alone — padding it would invent a third code block',
  (renderPartial(fourFences).match(/<pre>/g) || []).length === 2, renderPartial(fourFences));

// ---- the empty buffer: rendered on every turn before the first delta ------------------------
check('an empty buffer renders to empty output, not to "undefined"',
  renderPartial('').trim() === '', renderPartial(''));

// ---- hostile replies (fix round 1) ----------------------------------------------------------
// An agent's reply is not trusted input, and this output goes into dangerouslySetInnerHTML in a
// DOM that can start and stop agents and read every conversation.
//
// The inertness test walks the EMITTED TAGS only. A substring search over the whole string
// cannot tell `<img onerror=...>` from the escaped, inert `&lt;img onerror=...&gt;` — it scored
// the working fix as broken when this check was first drafted. The scheme rule below is written
// out independently rather than importing the view's own safeHref(), so the check cannot pass
// by agreeing with a bug in the thing it is checking.
const DANGEROUS_TAG = /^(?:script|iframe|object|embed|style|link|meta|form|base|svg|math|applet)$/;
const URL_ATTR = /^(?:href|src|xlink:href|action|formaction|data|poster)$/;
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
// Attribute NAME=VALUE pairs. Splitting these out matters: an earlier draft searched the whole
// attribute blob for /\son[a-z]+=/ and flagged `alt="&quot; onerror=&quot;alert(1)"` as live. It
// is not — an entity inside a quoted value decodes to part of the VALUE, because the delimiter
// is settled before entities are decoded. A detector that cannot tell an attribute name from an
// attribute value reports a working guard as broken, which is its own kind of useless.
const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const decodeEntities = s => s
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n');
function liveBits(htmlStr) {
  const bad = [];
  TAG.lastIndex = 0;
  let m;
  while ((m = TAG.exec(htmlStr))) {
    const tag = m[1].toLowerCase(), attrs = m[2] || '';
    if (DANGEROUS_TAG.test(tag)) bad.push('tag:<' + tag + '>');
    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(attrs))) {
      const nm = a[1].toLowerCase();
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      if (/^on[a-z]+$/.test(nm)) { bad.push('event-attr:' + nm); continue; }
      if (nm === 'srcdoc') { bad.push('srcdoc'); continue; }
      if (!URL_ATTR.test(nm)) continue;
      const v = decodeEntities(val).replace(/[\u0000-\u0020]+/g, '');
      const head = v.split(/[/?#]/, 1)[0];
      const colon = head.indexOf(':');
      const scheme = colon === -1 ? '' : head.slice(0, colon);
      // A COLON DOES NOT MAKE A SCHEME. Found by fuzzing (Task 9, seed 35, case 9593): a reference
      // definition with an angle-bracket destination and a LEADING SPACE — `[r]: < mailto:a@b.c>` —
      // makes marked emit href="%20mailto:a@b.c", because cleanUrl runs encodeURI over the
      // destination and the leading space becomes %20. The old rule read "%20mailto" as an unknown
      // scheme and flagged a link that is completely inert: a scheme is `[a-zA-Z][a-zA-Z0-9+.-]*`
      // in every URL parser, "%20mailto" cannot be one, so the browser resolves the whole thing as
      // a RELATIVE path (measured: https://<host>/ui/agents/%20mailto:a@b.c). Percent-encoding can
      // only ever DESTROY a scheme, never mint one, so narrowing the rule this way cannot hide a
      // live URL.
      //
      // The entity decode above still runs FIRST and is untouched, so "&#106;avascript&#58;"
      // decodes to a syntactically valid "javascript" and is still flagged — the two assertions
      // below pin both directions. What a false positive actually costs is why this was worth
      // fixing rather than exempting: an oracle that cries wolf is one people start overriding.
      if (scheme && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme) && !/^(?:https?|mailto)$/i.test(scheme)) bad.push('url:' + val);
    }
  }
  return bad;
}
// Sanity-check the detector itself, both directions, so a detector that quietly stopped
// detecting cannot carry the whole section green.
check('[detector] flags a real script tag', liveBits('<script>x</script>').length > 0);
check('[detector] flags a real event-handler attribute',
  liveBits('<img src="a.png" onerror="alert(1)">').length > 0);
check('[detector] flags a real javascript: href',
  liveBits('<a href="javascript:alert(1)">x</a>').length > 0);
check('[detector] does not flag escaped markup in text',
  liveBits('<p>&lt;script&gt;x&lt;/script&gt; and &lt;img onerror=y&gt;</p>').length === 0,
  liveBits('<p>&lt;script&gt;x&lt;/script&gt; and &lt;img onerror=y&gt;</p>'));
check('[detector] does not flag an entity-quoted handler sitting INSIDE an attribute value',
  liveBits('<img src="a.png" alt="&quot; onerror=&quot;alert(1)">').length === 0,
  liveBits('<img src="a.png" alt="&quot; onerror=&quot;alert(1)">'));
// The scheme-syntax rule, both directions (see liveBits' own comment). Percent-encoding cannot
// mint a scheme, so a percent-mangled one is a relative URL and must not be flagged...
check('[detector] does not flag a percent-mangled pseudo-scheme, which is a relative URL',
  liveBits('<a href="%20mailto:a@b.c">r</a>').length === 0,
  liveBits('<a href="%20mailto:a@b.c">r</a>'));
// ...while an ENTITY-encoded one decodes to a real scheme before the rule is applied, and must be.
check('[detector] still flags an entity-encoded scheme, which does decode to a real one',
  liveBits('<a href="&#106;avascript&#58;alert(1)">r</a>').length > 0,
  liveBits('<a href="&#106;avascript&#58;alert(1)">r</a>'));

// ---- the premise the C1 fix rests on ------------------------------------------------------
// The fix (a Tokenizer.tag override that clears lexer.state.inRawBlock) is worth exactly as much
// as the claim that the hazard is still there to neutralise. So assert the hazard directly,
// against the vendored marked with NO renderer and NO tokenizer of ours.
//
// IF THIS GOES RED, nothing is necessarily broken: it most likely means a newer marked was
// vendored that escapes inline text unconditionally, and the override in views/chat.mjs may have
// become vestigial. Re-derive it before deleting anything — the override is also what keeps the
// behaviour correct if the flag comes back.
{
  const flip = 'use the <script> tag, then <img/src=x onerror=alert(1)>';
  const unguarded = rawMarked.parse(flip, { async: false });
  check('[mechanism] the vendored marked does still emit raw inline text after an inRawBlock flip',
    liveBits(unguarded).length > 0, unguarded);
}

const HOSTILE = {
  'a raw <script> block': '<script>alert(1)</script>',
  'an <img onerror> handler': '<img src=x onerror="alert(1)">',
  'an <svg onload> handler': '<svg onload="alert(1)"></svg>',
  'an <iframe>': '<iframe src="javascript:alert(1)"></iframe>',
  'a javascript: link': '[click me](javascript:alert(1))',
  'a data:text/html link': '[click me](data:text/html;base64,PHN2Zz9vbmxvYWQ9YWxlcnQoMSk+)',
  'inline HTML mid-sentence': 'the log said <img src=x onerror=alert(1)> and then stopped',
  'a <style> block': '<style>body{display:none}</style>',
  'a mixed-case JaVaScRiPt: link': '[x](JaVaScRiPt:alert(1))',
  'an entity-smuggled scheme': '[x](&#106;avascript&#58;alert(1))',
  // The next two are inert even UNGUARDED (marked escapes alt and title in outputLink), so
  // they pin marked's behaviour, not ours — same convention as the [marked, not renderPartial]
  // assertions above. Re-review R4.
  '[marked, not our guard] an alt-attribute breakout': '![" onerror="alert(1)](https://example.com/a.png)',
  '[marked, not our guard] a title-attribute breakout': '[t](https://example.com "\\" onmouseover=\\"alert(1)")',

  // ---- flip-then-malformed (review C1/H1) -------------------------------------------------
  // Every fixture ABOVE is a single well-formed tag or link destination, and a single
  // well-formed tag is exactly the case that DOES become an `html` token and IS guarded. That
  // is why 14 green fixtures and two separate hand-probes all missed C1: the hole is in the
  // tokens that never become `html` tokens. marked's inline tag tokenizer sets
  // lexer.state.inRawBlock on <pre|code|kbd|script, inlineText() then stops escaping, and the
  // flag persists for the REST OF THE MESSAGE — across paragraphs, list items, blockquotes and
  // table cells. So each of these primes the flag with one construct and attacks with another,
  // and the payload is a shape marked's tag regex rejects but a browser accepts.
  // Every one of these was LIVE against the code as shipped in round 1.
  'flip via <script> in prose, then a slash-tag': 'use the <script> tag carefully, then "<img/src=x onerror=alert(1)>',
  'flip via <code>, attack in the NEXT PARAGRAPH': 'I used the <code> element here.\n\nNext paragraph: <img/src=x onerror=alert(1)>',
  'flip via <pre>, then a raw javascript: anchor': 'a <pre> b\n\n<a/href="javascript:alert(1)">click</a>',
  'flip via <kbd>, then an iframe srcdoc': 'a <kbd> b\n\n<iframe/srcdoc="&lt;script&gt;x&lt;/script&gt;">',
  'flip via <code>, then an svg onload': 'x <code> <svg/onload=alert(1)>',
  'flip via <code>, attack in a LIST ITEM': 'a <code> b\n\n- item one\n- <img/src=x onerror=alert(1)>',
  'flip via <code>, attack in a BLOCKQUOTE': 'a <code> b\n\n> quoted <img/src=x onerror=alert(1)>',
  'flip via <code>, attack in a TABLE CELL': 'a <code> b\n\n| h |\n| --- |\n| <img/src=x onerror=alert(1)> |',
  'a complete script, then a trailing </script fragment': '<script>alert(1)</script> then </script',
  'a slash-tag with no flip at all (control: was always inert)': '<img/src=x onerror=alert(1)>',

  // ---- distinct MECHANISMS, not just more of the same shape -------------------------------
  // A reference definition carries the destination far away from the use, so a scheme can hide
  // in a line that does not look like a link at all. It still reaches safeHref via outputLink.
  'a reference link whose DEFINITION carries the scheme': '[click][r]\n\n[r]: javascript:alert(1)',
  'a reference IMAGE whose definition carries the scheme': '![alt][r]\n\n[r]: javascript:alert(1)',
  'a shortcut reference': '[r]\n\n[r]: javascript:alert(1)',
  // The flip regex is /^<(pre|code|kbd|script)(\s|>)/i -- case-insensitive, and an attribute
  // counts as the \s. Both flip; both must still be inert.
  'a flip via an UPPERCASE tag': 'a <CODE> b\n\n<img/src=x onerror=alert(1)>',
  'a flip via a tag carrying attributes': 'a <code class="x"> b\n\n<img/src=x onerror=alert(1)>',
  // Found by the fuzz pass below rather than by anyone's imagination (seed 35, case 9593). An
  // angle-bracket reference destination with a LEADING SPACE: safeHref trims it and reads a
  // mailto, marked's cleanUrl encodeURIs it and emits "%20mailto:…", and the two disagree about
  // what the scheme is. Inert either way (see liveBits), and kept so the disagreement is pinned.
  'a reference destination whose leading space survives into the href': '[r]\n\n[r]: < mailto:a@b.c>',
  // (no self-closing "<code/>" fixture: the flip regex requires whitespace or > after the tag
  // name, so it never flips and such a fixture could not fail either way.)
};
// ---- two destinations that only LOOKED like they were testing our guard (Task 9) ------------
// Both were HOSTILE fixtures above until the fuzz pass sharpened liveBits' scheme rule (see its
// comment). Under the OLD rule they went red whenever safeHref was disabled -- but only because
// the detector read marked's own percent-encoding ("java%09script:") as an unknown scheme. A
// browser reads that as a RELATIVE path, so the redness was a false alarm and the coverage it
// provided was fake: these payloads are inert with the guard removed as well as with it present.
// The mutation sweep said so the moment the rule was corrected, which is what that tool is for.
//
// What actually separates the two states is whether an href is emitted AT ALL. Asserted directly,
// so these two now exercise the guard instead of the detector's imprecision.
const SMUGGLED = {
  'a tab-smuggled scheme (angle-bracket destination, which does reach the renderer)': '[x](<java\tscript:alert(1)>)',
  'a NUL-smuggled scheme': '[x](<jav\u0000ascript:alert(1)>)',
};
for (const [label, src] of Object.entries(SMUGGLED)) {
  const out = renderPartial(src);
  check(`a smuggled scheme is refused outright, emitting no href: ${label}`, !/href=/.test(out), out);
}
for (const [label, src] of Object.entries(HOSTILE)) {
  const out = renderPartial(src);
  check(`hostile reply renders inert: ${label}`, liveBits(out).length === 0, { bits: liveBits(out), out });
}
// renderPartial runs on EVERY intermediate buffer, not just the finished reply, so a payload
// that is inert when whole can still be live when half-arrived — a delta boundary is wherever
// the model's tokeniser happened to break, not a place the payload author chose. Walk every
// prefix of every hostile fixture. This closes the open item the round-1 report and the review
// both listed as untested: hostile markup was only ever fed in as a single complete delta.
{
  let worst = null, prefixes = 0;
  for (const [label, src] of Object.entries(HOSTILE)) {
    for (let i = 1; i <= src.length && !worst; i++) {
      prefixes++;
      const bits = liveBits(renderPartial(src.slice(0, i)));
      if (bits.length) worst = { label, i, prefix: src.slice(0, i), bits };
    }
  }
  check('no PREFIX of any hostile fixture renders live',
    worst === null, worst || { prefixesWalked: prefixes });
}

// Inert must not mean invisible: the operator has to be able to SEE what the agent said, or a
// hostile reply becomes an invisible one and the guard hides an attack instead of defusing it.
const shown = visible(renderPartial('<script>alert(1)</script>'));
check('a neutralised <script> is still shown to the operator as text',
  shown.includes('<script>') && shown.includes('alert(1)'), shown);
const linkText = visible(renderPartial('[click me](javascript:alert(1))'));
check('a refused link degrades to its own link text, it is not dropped',
  linkText.includes('click me'), linkText);

// ---- the double-escaping trap, which is why the RENDERER is overridden and not the input -----
// Pre-escaping the text before marked.parse() defuses the same attacks and silently corrupts
// every code block that contains a comparison or an ampersand. This pins the behaviour that
// rules that fix out.
const codeOut = renderPartial('```js\nif (1 < 2 && 3 > 2) { ok(); }\n```');
check('a code block containing < & > is escaped exactly once, not twice',
  visible(codeOut).includes('if (1 < 2 && 3 > 2) { ok(); }'), visible(codeOut));
check('no double-escaped entity (&amp;lt; / &amp;amp;) reaches the output',
  !/&amp;(?:lt|gt|amp|quot|#\d)/.test(codeOut), codeOut);
const proseOut = renderPartial('a < b and c > d, tom & jerry');
check('ordinary prose with angle brackets and an ampersand survives intact',
  visible(proseOut).includes('a < b and c > d, tom & jerry'), visible(proseOut));
const okLink = renderPartial('[docs](https://example.com/a?b=1&c=2)');
check('an ordinary https link still renders as a link',
  /<a href="https:\/\/example\.com\/a\?b=1&c=2"[^>]*>docs<\/a>/.test(okLink), okLink);
// Protocol-relative destinations have an EMPTY head, so a plain "has it got a scheme?" test
// waves them through as relative. They are not relative: they are off-site navigation on click,
// from a dashboard whose whole subject is this box (review L1). Asserted as "no anchor carrying
// that host", not as "no backticks", so it fails if the refusal is dropped.
//
// Note the backslash arithmetic. In markdown a backslash escapes the next character, so TWO
// backslashes in the source are ONE by the time the tokenizer sees it -- and one backslash is
// harmless here: encodeURI turns it into %5C, which resolves same-origin. A genuine two-
// backslash destination needs FOUR in the source. The first draft of this fixture used two and
// reported correct code as broken.
for (const [label, src] of Object.entries({
  'a link': '[x](//evil.example/path)',
  'an angle-bracket destination': '[x](<//evil.example/path>)',
  // (no autolink case: marked does not treat a scheme-less angle destination as an autolink,
  // so there is nothing for safeHref to refuse and such a fixture could never fail.)
  'an image': '![x](//evil.example/a.png)',
  'a port-bearing host': '[x](//evil.example:8080/p)',
  'a real two-backslash destination': '[x](\\\\\\\\evil.example/share)',
})) {
  const out = renderPartial(src);
  check(`an off-site protocol-relative destination in ${label} does not reach an href`,
    !/(?:href|src)="[^"]*evil\.example/.test(out), out);
}
// The single-backslash case is NOT refused, and does not need to be: it resolves same-origin.
// Pinned so nobody "fixes" it into a refusal on the strength of how it looks.
const oneSlash = renderPartial('[x](\\\\evil.example/share)');
const oneSlashHref = (oneSlash.match(/href="([^"]*)"/) || [])[1];
check('a single-backslash destination stays a same-origin relative path',
  oneSlashHref === '%5Cevil.example/share'
  && new URL(oneSlashHref, 'https://dash.example/ui/agents/x').host === 'dash.example', oneSlashHref);

const relLink = renderPartial('[rel](./notes.md)');
check('a relative link has no scheme to abuse and is still rendered',
  /<a href="\.\/notes\.md"[^>]*>rel<\/a>/.test(relLink), relLink);
const okImg = renderPartial('![a diagram](https://example.com/d.png)');
check('an ordinary https image still renders as an image',
  /<img src="https:\/\/example\.com\/d\.png" alt="a diagram">/.test(okImg), okImg);

// ---- a random-input pass, because every fixture above is one a person thought of -------------
//
// The method that produced fourteen green hostile fixtures was also blind to a Critical stored
// XSS for two rounds: each fixture is a single construct someone chose, and C1 lived in the
// COMBINATION of two (an inline tag that flips marked's inRawBlock, and a payload shape marked's
// tag regex rejects). Enumerating combinations by hand is exactly what people are bad at, so a
// generator does it instead.
//
// DETERMINISTIC ON PURPOSE. A fixed seed list, not Math.random: a gate that fails one run in
// fifty teaches people to re-run it, and scripts/chat-view-coverage.mjs re-executes this file
// twenty-odd times and needs two runs to be comparable. Exploratory sweeps over many more seeds
// are a separate thing you run by hand; what is committed is the corpus that must stay green.
//
// The alphabet is an attacker's vocabulary — tag names, event attributes, URL attributes,
// schemes, and the SEPARATORS that decide whether marked sees a tag at all — because random
// bytes would essentially never produce a tag and would test nothing. Control bytes are built
// with fromCharCode rather than written as escapes: editing tools on this branch have twice
// rewritten such an escape into a raw embedded byte, which preflight now rejects outright.
{
  const NUL = String.fromCharCode(0), TABC = String.fromCharCode(9), LF = String.fromCharCode(10), CR = String.fromCharCode(13);
  // mulberry32: a finding has to be reproducible from its seed or it is an anecdote.
  const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const TAGS = ['script', 'img', 'svg', 'iframe', 'style', 'pre', 'code', 'kbd', 'a', 'math', 'object', 'embed', 'form', 'input', 'template', 'noscript', 'title', 'textarea', 'base', 'link', 'meta', 'video', 'source', 'body', 'p', 'CODE', 'ScRiPt', 'applet'];
  const EVENTS = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onanimationend', 'ontoggle', 'onbegin'];
  const URLATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'srcdoc'];
  const SCHEMES = ['javascript:', 'JaVaScRiPt:', 'data:text/html,', 'vbscript:', 'jav' + TABC + 'ascript:', 'jav' + LF + 'ascript:', 'jav' + NUL + 'ascript:', '&#106;avascript:', '&#x6a;avascript&#58;', ' javascript:', '//evil.example', '\\\\evil.example', 'https://ok.example', 'mailto:a@b.c', '/relative', '#frag'];
  const SEPS = ['', ' ', '/', TABC, LF, '  ', NUL, CR];
  const TEXT = ['the log said', 'use the', 'tag carefully', 'then', 'a', 'b', 'item', 'quoted', 'x', 'df -h', 'ok', '1 < 2 && 3 > 2', 'héllo', '\u{1f44b}', '`tick`'];
  const PUNCT = ['&', '<', '>', '"', "'", '&amp;', '&lt;', '&#39;', '&quot;', NUL, TABC, '```', '~~~', '\\'];
  const WRAP = [
    s => s, s => '- ' + s, s => '> ' + s,
    s => '| h |' + LF + '| --- |' + LF + '| ' + s + ' |',
    s => '# ' + s,
    s => '```' + LF + s + LF + '```',
    s => '```js' + LF + s,
    s => '`' + s + '`', s => '**' + s + '**',
    s => '[link](' + s + ')', s => '![alt](' + s + ')',
    s => '[r]' + LF + LF + '[r]: ' + s,
    s => '<!-- ' + s + ' -->', s => '<' + s + '>',
  ];
  const frag = r => {
    const pick = a => a[Math.floor(r() * a.length)];
    const k = r();
    if (k < 0.34) {
      const t = pick(TAGS), sep = pick(SEPS), bits = [];
      if (r() < 0.6) bits.push(pick(EVENTS) + '=' + (r() < 0.5 ? '"alert(1)"' : 'alert(1)'));
      if (r() < 0.6) bits.push(pick(URLATTRS) + '=' + (r() < 0.5 ? '"' + pick(SCHEMES) + '"' : pick(SCHEMES)));
      if (r() < 0.3) bits.push('class="' + pick(TEXT) + '"');
      return '<' + t + sep + bits.join(pick(SEPS) || ' ') + (r() < 0.85 ? '>' : '');
    }
    if (k < 0.5) return pick(SCHEMES);
    if (k < 0.62) return '</' + pick(TAGS) + (r() < 0.7 ? '>' : '');
    if (k < 0.72) return pick(PUNCT);
    return pick(TEXT);
  };
  const doc = r => {
    const parts = [], n = 1 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      let s = '';
      const m = 1 + Math.floor(r() * 4);
      for (let j = 0; j < m; j++) s += frag(r) + (r() < 0.5 ? ' ' : '');
      parts.push(WRAP[Math.floor(r() * WRAP.length)](s));
    }
    return parts.join(r() < 0.5 ? LF + LF : LF);
  };

  // 6,000 cases, which is what keeps this file's runtime about a second -- it is re-executed
  // twenty-odd times by scripts/chat-view-coverage.mjs, so a slow gate here is a slow sweep there.
  // This corpus is the FLOOR, not the search: the exploratory run behind Task 9 was 60 seeds x
  // 20,000 cases plus ~8.4M walked prefixes, and its one finding (seed 35, case 9593 -- the
  // "%20mailto:" scheme imprecision corrected in liveBits above) is pinned as its own named
  // fixture in HOSTILE rather than being left to a seed that would have to stay in range forever.
  const SEEDS = [1, 2, 3, 35, 101], PER = 1200;
  const corpus = [];
  for (const sd of SEEDS) { const r = rng(sd); for (let i = 0; i < PER; i++) corpus.push({ seed: sd, i, src: doc(r) }); }

  // (a) THE CORPUS MUST BE CAPABLE OF THE THING IT IS LOOKING FOR. A generator that quietly
  // degenerated into plain prose would report "0 live" forever and look like the strongest
  // assertion in this file. So run the same corpus through the UNGUARDED vendored marked: if that
  // does not produce live output in quantity, nothing below means anything.
  let unguarded = 0;
  for (const c of corpus) {
    let o; try { o = rawMarked.parse(c.src, { async: false }); } catch { continue; }
    if (liveBits(o).length) unguarded++;
  }
  console.log(`  fuzz: ${corpus.length} generated replies over seeds ${SEEDS.join(',')}; ${unguarded} of them render live through UNGUARDED marked`);
  check('[fuzz] the corpus can produce live output at all, measured against unguarded marked',
    unguarded > corpus.length / 20, unguarded);

  // (b) the whole reply, as a finished turn
  let live = null;
  for (const c of corpus) {
    let out;
    try { out = renderPartial(c.src); } catch (e) { live = { ...c, threw: String(e) }; break; }
    const bits = liveBits(out);
    if (bits.length) { live = { ...c, bits, out: out.slice(0, 300) }; break; }
  }
  check('[fuzz] no generated reply renders live through renderPartial',
    live === null, live);

  // (c) and as a half-arrived one. renderPartial runs on EVERY intermediate buffer, and a delta
  // boundary falls wherever the model's tokeniser happened to break -- not where a payload author
  // chose. Every prefix of every case is too slow for a gate that runs in CI and under the
  // mutation sweep, so a fixed sample of cases is walked exhaustively.
  let livePrefix = null, walked = 0;
  for (let n = 0; n < corpus.length && !livePrefix; n += 50) {
    const { src, seed, i } = corpus[n];
    for (let p = 1; p <= src.length; p++) {
      walked++;
      let out;
      try { out = renderPartial(src.slice(0, p)); } catch (e) { livePrefix = { seed, i, p, threw: String(e) }; break; }
      if (liveBits(out).length) { livePrefix = { seed, i, p, prefix: src.slice(0, p), bits: liveBits(out) }; break; }
    }
  }
  console.log(`  fuzz: ${walked} intermediate prefixes walked`);
  check('[fuzz] no PREFIX of a generated reply renders live either',
    livePrefix === null, livePrefix);
}

// ---- reconcile(): what survives the refetch that replaces the screen (Task 9 fix round 1) -----
//
// A turn ends, the client refetches chat.jsonl, and that list REPLACES what is on screen. Anything
// the client added optimistically and the transcript does not carry is therefore deleted. Round 1
// protected the agent's reply and not the operator's own message, and Task 9 measured the result in
// a real browser: `you` bubble at t+2 ms, gone at t+21 ms, `.cherr` null. These assertions are
// about the half that was missing, plus the half that already worked, because the fix moved both
// into one function and either could have broken the other.
const U = (text, at) => ({ at: at || '2026-09-16T10:00:00Z', role: 'user', text });
const A = (text, at) => ({ at: at || '2026-09-16T10:00:01Z', role: 'assistant', text });
const texts = r => r.turns.map(t => t.role + ':' + t.text).join('|');
{
  // The happy path: cmd_chat appended the user record before spawning, so the transcript has it.
  // Nothing is added and nothing is reported — a fix that cried wolf on every successful turn
  // would be worse than the bug.
  const ok = reconcile([U('hello'), A('hi')], [U('hello')], '');
  check('reconcile: a message the transcript already has is not re-added',
    texts(ok) === 'user:hello|assistant:hi' && ok.missingUsers.length === 0, ok);

  // The defect: the turn ended before the agent recorded anything.
  const lost = reconcile([U('older'), A('older reply')], [U('what did the last run find?')], '');
  check('reconcile: a message the transcript does NOT have is put back',
    texts(lost) === 'user:older|assistant:older reply|user:what did the last run find?', lost);
  check('reconcile: ...and is REPORTED missing, so the caller can say so',
    lost.missingUsers.length === 1 && lost.missingUsers[0].text === 'what did the last run find?', lost.missingUsers);

  // Multiset, not set. Asking the same thing twice is two messages; membership-matching would call
  // the second one saved because the first one was, and delete it.
  const twice = reconcile([U('ping')], [U('ping'), U('ping')], '');
  check('reconcile: the same question asked twice is two messages, not one',
    twice.missingUsers.length === 1 && texts(twice) === 'user:ping|user:ping', twice);

  // Order: the question comes before the reply it produced, not after it.
  const both = reconcile([], [U('q')], 'the answer');
  check('reconcile: a salvaged reply is appended AFTER the question it answers',
    texts(both) === 'user:q|assistant:the answer', both);

  // The reply rules M1/R5 put in, unchanged by the move.
  const saved = reconcile([U('q'), A('the answer, complete')], [], 'the answer');
  check('reconcile: a reply the newest assistant turn already carries is not duplicated',
    texts(saved) === 'user:q|assistant:the answer, complete' && saved.salvagedReply === false, saved);
  const stale = reconcile([U('q'), A('a reply from an EARLIER turn')], [], 'the answer');
  check('reconcile: a stale assistant turn does not count as this reply being saved',
    stale.salvagedReply === true && texts(stale).endsWith('assistant:the answer'), stale);
  check('reconcile: no salvage means no assistant turn is invented',
    reconcile([U('q')], [], '').salvagedReply === false, reconcile([U('q')], [], ''));
  // The catch path reconciles against the CURRENT turns, which already contain the pending
  // message. It must match itself rather than being appended a second time.
  const again = reconcile([U('q'), A('partial')], [U('q')], 'partial and then some');
  check('reconcile: run against a list that already holds the pending message, it adds no duplicate',
    again.missingUsers.length === 0 && again.turns.filter(t => t.role === 'user').length === 1, again);
}

// ---- the cross-turn repeat, which round 1's fixtures could not have caught (review F1) --------
//
// Every fixture above uses a text that appears nowhere else in the transcript, so all of them stay
// green while a repeated question is silently deleted. These use a transcript that ALREADY CONTAINS
// the text being sent — the only shape that can tell membership-matching apart from counting.
{
  // Asked once, saved. Asked again, and the turn dies before anything is recorded: the transcript
  // still holds exactly one "status?", and the pending was sent when it held one, so it is NOT
  // accounted for. Round 1 declared it saved and dropped it with no warning.
  const repeat = reconcile([U('status?'), A('all green')], [{ ...U('status?'), baseline: 1 }], '');
  check('reconcile: a REPEATED question is not absorbed by the earlier one that was saved',
    repeat.missingUsers.length === 1 && texts(repeat) === 'user:status?|assistant:all green|user:status?', repeat);
  // ...and the happy path for that same repeat: the transcript comes back with two, so it IS saved.
  const repeatOk = reconcile([U('status?'), A('all green'), U('status?')], [{ ...U('status?'), baseline: 1 }], '');
  check('reconcile: ...and once the transcript does carry the second one, it is not re-added',
    repeatOk.missingUsers.length === 0 && repeatOk.turns.length === 3, repeatOk);
  // Two sent back to back while the first is still pending share one baseline, and the transcript
  // accounts for exactly one of them.
  const both = reconcile([U('ping'), A('pong'), U('ping')],
    [{ ...U('ping'), baseline: 1 }, { ...U('ping'), baseline: 1 }], '');
  check('reconcile: two identical messages in flight, one recorded — exactly one is reported lost',
    both.missingUsers.length === 1, both);
  // The baseline is a floor, not an equality: a transcript that gained two while one was pending
  // still accounts for that one.
  const grew = reconcile([U('q'), U('q'), U('q')], [{ ...U('q'), baseline: 1 }], '');
  check('reconcile: a transcript that gained more copies than expected still accounts for the pending',
    grew.missingUsers.length === 0, grew);
  // No baseline at all (a direct caller, or a pending from before this rule) means 0, which is the
  // round-1 behaviour rather than a crash.
  const noBase = reconcile([A('hi')], [U('fresh')], '');
  check('reconcile: a pending with no baseline still works, it is not required',
    noBase.missingUsers.length === 1, noBase);
}

// ---- a lost message is named ONCE, not on every turn afterwards (review F2) --------------------
//
// Round 1 kept it pending forever, so it was re-appended below every later question AND its reply,
// and the alert re-fired each turn describing a failure several turns old.
{
  const lost = { ...U('lost one'), baseline: 0 };
  const first = reconcile([U('prev'), A('prev reply')], [lost], '');
  check('reconcile: a lost message is shown and reported the first time',
    first.missingUsers.length === 1 && texts(first).endsWith('user:lost one'), first);
  // The caller marks what it reported; the next turn must retire it rather than re-append it.
  const reported = first.missingUsers.map(q => ({ ...q, reported: true }));
  const second = reconcile([U('prev'), A('prev reply'), U('next'), A('next reply')], reported, '');
  check('reconcile: on the NEXT turn it is retired, not re-appended below a later exchange',
    second.missingUsers.length === 0 && !texts(second).includes('lost one'), second);
  check('reconcile: ...and the caller can see it was retired rather than saved',
    second.retired.length === 1 && second.retired[0].text === 'lost one', second.retired);
  // A reported pending that DOES turn up in the transcript counts as saved, not as retired — the
  // two states are different and the caller says different things about them.
  const landed = reconcile([U('lost one')], reported, '');
  check('reconcile: a reported message that turns up in the transcript is saved, not retired',
    landed.retired.length === 0 && landed.missingUsers.length === 0, landed);
}

process.exit(failed ? 1 : 0);
