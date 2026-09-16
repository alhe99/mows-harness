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
check('no U+FFFD replacement character is introduced', !accentOut.includes('�'), accentOut);

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

process.exit(failed ? 1 : 0);
