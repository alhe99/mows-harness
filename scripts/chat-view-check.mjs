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

const { renderPartial } = await import(new URL('views/chat.mjs', APP).href);

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
      if (colon !== -1 && !/^(?:https?|mailto)$/i.test(head.slice(0, colon))) bad.push('url:' + val);
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
  'a tab-smuggled scheme (angle-bracket destination, which does reach the renderer)': '[x](<java\tscript:alert(1)>)',
  'a NUL-smuggled scheme': '[x](<jav\u0000ascript:alert(1)>)',
  'an alt-attribute breakout': '![" onerror="alert(1)](https://example.com/a.png)',
  'a title-attribute breakout': '[t](https://example.com "\\" onmouseover=\\"alert(1)")',
};
for (const [label, src] of Object.entries(HOSTILE)) {
  const out = renderPartial(src);
  check(`hostile reply renders inert: ${label}`, liveBits(out).length === 0, { bits: liveBits(out), out });
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
const relLink = renderPartial('[rel](./notes.md)');
check('a relative link has no scheme to abuse and is still rendered',
  /<a href="\.\/notes\.md"[^>]*>rel<\/a>/.test(relLink), relLink);
const okImg = renderPartial('![a diagram](https://example.com/d.png)');
check('an ordinary https image still renders as an image',
  /<img src="https:\/\/example\.com\/d\.png" alt="a diagram">/.test(okImg), okImg);

process.exit(failed ? 1 : 0);
