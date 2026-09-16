// Mutation coverage for scripts/chat-view-check.mjs — the check on the check.
//
// chat-view-check.mjs prints 60-odd PASS lines. That number is worth nothing on its own: an
// assertion that cannot fail passes just as loudly as one that can. This tool breaks one thing at
// a time, re-runs the check, and records which assertions go red. Anything that never goes red
// under any mutation is reported BY NAME, because it is proving nothing.
//
// It exists in the tree (re-review R2) because the claim "63 assertions, all 63 proven able to
// fail" is the reason to believe every other number in the Task 7 report, and a claim that rests
// on a tool nobody else can run is the weakest kind. Re-run it after adding an assertion.
//
// THREE-WAY ACCOUNTING, and why it is the point. The first version of this tool ran each mutation
// with output discarded and treated "did not crash" as "was applied". When two mutation targets
// moved during a refactor, nine assertions silently stopped being covered and it still printed
// "(none)". So a mutation now lands in exactly one of three buckets — applied, failed to apply,
// applied but changed nothing — and the last two poison the whole run rather than being absorbed.
// A gate that cannot run must say so, not return green.
//
//   node scripts/chat-view-coverage.mjs              full sweep, non-zero exit on any gap
//   node scripts/chat-view-coverage.mjs --self-test  prove THIS tool can fail, three ways
//
// Requires Node >= 22.15, same as the check it drives (node:module.registerHooks).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  view: path.join(ROOT, 'infra/dashboard/app/views/chat.mjs'),
  check: path.join(ROOT, 'scripts/chat-view-check.mjs'),
  vendor: path.join(ROOT, 'infra/dashboard/app/vendor/marked.mjs'),
};
const CHECK = FILES.check;

// Each mutation is a literal find/replace against one file. Written out rather than kept in a
// scratch directory so the next person can read exactly what "proven able to fail" was proven
// against. `vendor` mutations are restored byte-identically, so SHA256SUMS still verifies after.
const MUTATIONS = [
  // --- the markdown rendering itself -------------------------------------------------------
  { id: 'M1', file: 'view', desc: 'renderPartial no longer closes an open fence',
    find: "marked.parse(fences % 2 ? text + '\\n```' : text, { async: false, renderer, tokenizer })",
    repl: 'marked.parse(text, { async: false, renderer, tokenizer })' },
  { id: 'M2', file: 'view', desc: 'paragraph breaks collapsed before parse',
    find: '  const fences = (text.match(/```/g) || []).length;',
    repl: "  text = text.replace(/\\n\\n/g, '\\n');\n  const fences = (text.match(/```/g) || []).length;" },
  { id: 'M3', file: 'view', desc: 'text re-decoded as latin1 (mojibake)',
    find: '  const fences = (text.match(/```/g) || []).length;',
    repl: "  text = Buffer.from(text, 'utf8').toString('latin1');\n  const fences = (text.match(/```/g) || []).length;" },
  { id: 'M4', file: 'view', desc: 'fence parity replaced by fence presence',
    find: 'fences % 2 ?', repl: 'fences > 0 ?' },
  { id: 'M5', file: 'view', desc: 'empty buffer rendered as literal undefined',
    find: 'export function renderPartial(text) {',
    repl: "export function renderPartial(text) {\n  if (!text) return '<p>undefined</p>';" },
  { id: 'M6', file: 'view', desc: 'non-ASCII replaced by U+FFFD',
    find: '  const fences = (text.match(/```/g) || []).length;',
    repl: "  text = text.replace(/[^\\x00-\\x7F]/g, '\\uFFFD');\n  const fences = (text.match(/```/g) || []).length;" },
  { id: 'M7', file: 'view', desc: 'markdown not rendered at all (raw text returned)',
    find: "    return marked.parse(fences % 2 ? text + '\\n```' : text, { async: false, renderer, tokenizer });",
    repl: '    return String(fences) && text;' },

  // --- the XSS guards ----------------------------------------------------------------------
  { id: 'X1', file: 'view', desc: 'raw HTML token passed through unescaped (round-1 defect)',
    find: "renderer.html = ({ raw, text }) => escapeHtml(raw ?? text ?? '');",
    repl: "renderer.html = ({ raw, text }) => (raw ?? text ?? '');" },
  { id: 'X2', file: 'view', desc: 'safeHref always true (cleanUrl-only, as before the fix)',
    find: 'function safeHref(href) {', repl: 'function safeHref(href) {\n  return true;' },
  { id: 'X3', file: 'view', desc: 'input pre-escaped instead of renderer overridden (the wrong fix)',
    find: '  const fences = (text.match(/```/g) || []).length;',
    repl: '  text = escapeHtml(text);\n  const fences = (text.match(/```/g) || []).length;' },
  { id: 'X4', file: 'view', desc: 'raw HTML dropped silently instead of shown defused',
    find: "renderer.html = ({ raw, text }) => escapeHtml(raw ?? text ?? '');",
    repl: "renderer.html = () => '';" },
  { id: 'X5', file: 'view', desc: 'refused link drops its own link text',
    find: '  return safeHref(token.href) ? Renderer.prototype.link.call(this, token) : this.parser.parseInline(token.tokens);',
    repl: "  return safeHref(token.href) ? Renderer.prototype.link.call(this, token) : '';" },
  { id: 'X6', file: 'view', desc: 'entity guard removed from the href head',
    find: '  if (/[&%]/.test(head)) return false;\n', repl: '' },
  // The realistic wrong turn: hand-rolling the <img> instead of deferring to the base renderer,
  // and re-emitting alt raw. The tokenizer had already escaped it; emitting it by hand without
  // re-escaping puts the attribute breakout back. This is the mutation the two
  // [marked, not our guard] fixtures answer to directly.
  { id: 'X8', file: 'view', desc: 'image hand-rolled, re-emitting alt unescaped',
    find: '  return safeHref(token.href) ? Renderer.prototype.image.call(this, token) : (token.text || \'\');',
    repl: `  const unesc = v => String(v).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  if (!safeHref(token.href)) return unesc(token.text || '');
  const ttl = token.title ? ' title="' + unesc(token.title) + '"' : '';
  return '<img src="' + token.href + '" alt="' + unesc(token.text || '') + '"' + ttl + '>';` },
  { id: 'X9', file: 'view', desc: 'tokenizer override removed — exactly the round-1 code (C1)',
    find: '{ async: false, renderer, tokenizer }', repl: '{ async: false, renderer }' },
  { id: 'X10', file: 'view', desc: 'protocol-relative refusal removed (L1)',
    find: '  if (/^[/\\\\]{2}/.test(h)) return false;\n', repl: '' },

  // --- the check's OWN detector -------------------------------------------------------------
  // A detector that has quietly stopped detecting would carry every hostile-input assertion
  // green, so it needs its own proof of failure as much as the code under test does.
  { id: 'D1', file: 'check', desc: 'detector reverted to the naive attribute-blob scan',
    find: `    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(attrs))) {
      const nm = a[1].toLowerCase();
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      if (/^on[a-z]+$/.test(nm)) { bad.push('event-attr:' + nm); continue; }`,
    repl: `    const naive = attrs.match(/\\son[a-z]+\\s*=/gi);
    if (naive) bad.push('event-attr:' + naive.join(','));
    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(attrs))) {
      const nm = a[1].toLowerCase();
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      if (false) { continue; }` },
  { id: 'D2', file: 'check', desc: 'detector stops detecting entirely',
    find: 'function liveBits(htmlStr) {\n  const bad = [];',
    repl: 'function liveBits(htmlStr) {\n  const bad = [];\n  if (htmlStr) return bad;' },
  { id: 'D3', file: 'check', desc: 'detector cannot tell live markup from escaped markup',
    find: `const TAG = /<([a-zA-Z][^\\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\\/?>/g;`,
    repl: `const TAG = /(?:<|&lt;)([a-zA-Z][^\\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\\/?(?:>|&gt;)/g;` },

  // --- the vendored dependency --------------------------------------------------------------
  // The [mechanism] assertion pins the HAZARD the C1 fix neutralises, which lives in marked
  // rather than in our code, so only a mutation of marked itself can redden it. This simulates
  // marked being fixed upstream: every hostile fixture stays inert (our override already made
  // them so) and only [mechanism] notices.
  { id: 'U1', file: 'vendor', desc: 'marked escapes inline text unconditionally (hazard fixed upstream)',
    find: '            if (this.lexer.state.inRawBlock) {\n                text = cap[0];\n            }',
    repl: '            if (false && this.lexer.state.inRawBlock) {\n                text = cap[0];\n            }' },
];

const read = f => readFileSync(FILES[f], 'utf8');
const write = (f, s) => writeFileSync(FILES[f], s);

function runCheck() {
  // The check exits non-zero when anything fails, which is the normal case here, so the throw
  // carries the output rather than the status.
  try {
    return execFileSync(process.execPath, [CHECK], { encoding: 'utf8', cwd: ROOT });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}
const names = (out, kind) => out.split('\n')
  .filter(l => l.startsWith(kind + ': ')).map(l => l.slice(kind.length + 2));

function sweep(mutations) {
  const backup = Object.fromEntries(Object.keys(FILES).map(k => [k, read(k)]));
  const restore = () => { for (const k of Object.keys(FILES)) write(k, backup[k]); };
  const baseline = runCheck();
  const all = new Set(names(baseline, 'PASS'));
  if (names(baseline, 'FAIL').length) {
    restore();
    return { fatal: 'the check does not pass on an unmutated tree; fix that before reading coverage',
      baselineFailures: names(baseline, 'FAIL') };
  }
  const everRed = new Set();
  const broken = [];
  try {
    for (const m of mutations) {
      const before = backup[m.file];
      let mutated;
      if (!before.includes(m.find)) {
        broken.push(`${m.id}: FAILED TO APPLY — target text not found (moved?)`);
        continue;
      }
      if (before.split(m.find).length - 1 !== 1) {
        broken.push(`${m.id}: FAILED TO APPLY — target text is ambiguous (${before.split(m.find).length - 1} matches)`);
        continue;
      }
      mutated = before.replace(m.find, m.repl);
      if (mutated === before) { broken.push(`${m.id}: CHANGED NOTHING`); continue; }
      write(m.file, mutated);
      for (const n of names(runCheck(), 'FAIL')) everRed.add(n);
      write(m.file, before);
    }
  } finally {
    restore();
  }
  const neverRed = [...all].filter(n => !everRed.has(n)).sort();
  return { total: all.size, everRed: everRed.size, neverRed, broken };
}

function report(r) {
  if (r.fatal) {
    console.log('FATAL: ' + r.fatal);
    for (const f of r.baselineFailures) console.log('  baseline FAIL: ' + f);
    return 1;
  }
  console.log(`assertions total : ${r.total}`);
  console.log(`ever observed red: ${r.everRed}`);
  console.log('');
  console.log('NEVER RED (each of these proves nothing):');
  if (r.neverRed.length) for (const n of r.neverRed) console.log('  - ' + n);
  else console.log('  (none)');
  console.log('');
  if (r.broken.length) {
    for (const b of r.broken) console.log('  ' + b);
    console.log('SOME MUTATIONS DID NOT RUN — the numbers above are NOT trustworthy');
  } else {
    console.log(`all ${MUTATIONS.length} mutations applied`);
  }
  return (r.broken.length || r.neverRed.length) ? 1 : 0;
}

if (process.argv.includes('--self-test')) {
  // Prove this tool can fail, in each of the three ways it can be blind. Without this the
  // three-way accounting is itself an unverified claim -- the exact criticism that put this file
  // in the tree.
  let bad = 0;
  const expect = (label, cond, detail) => {
    console.log((cond ? 'PASS' : 'FAIL') + ': ' + label);
    if (!cond) { bad = 1; console.log('   got: ' + JSON.stringify(detail)); }
  };

  const a = sweep([{ id: 'ZZ', file: 'view', desc: 'target that does not exist',
    find: 'this text is not in the file and never was', repl: 'x' }]);
  expect('a mutation whose target has moved is reported, not absorbed',
    a.broken.some(b => b.includes('FAILED TO APPLY')), a.broken);

  // A UNIQUE target that replaces to itself — otherwise the ambiguity guard fires first and this
  // probe tests the wrong branch.
  const b = sweep([{ id: 'ZZ', file: 'view', desc: 'no-op',
    find: 'export function renderPartial(text) {', repl: 'export function renderPartial(text) {' }]);
  expect('a mutation that changes nothing is reported, not absorbed',
    b.broken.some(x => x.includes('CHANGED NOTHING')), b.broken);

  // An assertion nothing can break must be named. Append one, sweep, restore.
  const orig = read('check');
  try {
    write('check', orig.replace('process.exit(failed ? 1 : 0);',
      "check('AN ASSERTION NOTHING CAN BREAK', 1 === 1);\nprocess.exit(failed ? 1 : 0);"));
    const c = sweep(MUTATIONS);
    expect('an assertion no mutation can break is named',
      c.neverRed.includes('AN ASSERTION NOTHING CAN BREAK'), c.neverRed);
  } finally {
    write('check', orig);
  }

  const d = sweep(MUTATIONS);
  expect('the real sweep is clean: every assertion red at least once, every mutation applied',
    d.neverRed.length === 0 && d.broken.length === 0, { neverRed: d.neverRed, broken: d.broken });
  expect('all files restored byte-identically', read('check') === orig, 'check file differs');
  process.exit(bad);
}

process.exit(report(sweep(MUTATIONS)));
