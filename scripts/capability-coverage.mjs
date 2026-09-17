// Mutation coverage for scripts/capability-check.mjs — the check on the check.
//
// Same tool, same three-way accounting and the same reason as scripts/chat-view-coverage.mjs (read
// its header for the argument): a check that prints 60-odd PASS lines has proved nothing until each
// of those lines has been observed going red. This breaks one thing at a time, re-runs the check,
// and names any assertion that never reddens under any mutation.
//
// It matters more than usual here. The subject of this check is a panel whose whole job is to not
// overstate what it knows, and an assertion that cannot fail is itself an overstatement — the same
// error one level up.
//
//   node scripts/capability-coverage.mjs              full sweep, non-zero exit on any gap
//   node scripts/capability-coverage.mjs --self-test  prove THIS tool can fail, three ways
//
// Requires Node >= 22.15 and python3 with PyYAML, same as the check it drives.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  model: path.join(ROOT, 'infra/dashboard/capability.mjs'),
  view: path.join(ROOT, 'infra/dashboard/app/views/capability.mjs'),
  check: path.join(ROOT, 'scripts/capability-check.mjs'),
  meta: path.join(ROOT, 'agents/bin/mows-agent-meta'),
};
const CHECK = FILES.check;

// Each mutation is a literal find/replace against one file, written out rather than generated so
// the next person can read exactly what "proven able to fail" was proven against.
const MUTATIONS = [
  // --- the model: what it means to compute capability from the wrong thing --------------------
  // C1 makes the model read the DENY list as capability — the exact inversion the panel exists to
  // prevent. It adds rather than merely failing to subtract, so "Write never appears" can go red.
  { id: 'C1', file: 'model', desc: 'the deny list read as capability instead of subtracted from it',
    find: '  const effective = inherits ? [] : tools.filter(t => !denied.has(t));',
    repl: '  const effective = inherits ? [] : tools.concat([...denied]);' },
  { id: 'C2', file: 'model', desc: 'hasBroad hard-wired false — the "read-only" lie this task exists to stop',
    find: '    hasBroad: broad.length > 0,', repl: '    hasBroad: false,' },
  { id: 'C3', file: 'model', desc: 'inheritance computed but never reported (the panel sees an empty tool list)',
    find: '    inherits,', repl: '    inherits: false,' },
  { id: 'C4', file: 'model', desc: 'an unparseable tools: field collapses to the empty list (rounds toward restricted)',
    find: '  : null;', repl: '  : [];' },
  { id: 'C5', file: 'model', desc: 'the no-op deny list is no longer reported as one',
    find: "    denyNoop: inherits ? [] : [...denied].filter(t => !tools.includes(t)),",
    repl: '    denyNoop: [],' },
  { id: 'C6', file: 'model', desc: 'trigger types read straight off raw YAML (undefined reaches the panel)',
    find: "      triggerTypes: rawTrig.map(t => (t && typeof t === 'object' && typeof t.type === 'string') ? t.type : 'unknown'),",
    repl: '      triggerTypes: rawTrig.map(t => String(t?.type)),' },
  { id: 'C7', file: 'model', desc: 'webhookArmed defaults to false — an undetermined answer stated as "no"',
    find: "      webhookArmed: typeof opts.webhookArmed === 'boolean' ? opts.webhookArmed : null,",
    repl: '      webhookArmed: !!opts.webhookArmed,' },
  { id: 'C8', file: 'model', desc: 'BROAD_TOOLS drifts from mows-agent-meta WRITE_CAPABLE_TOOLS',
    find: "export const BROAD_TOOLS = new Set(['Bash', 'Task']);",
    repl: "export const BROAD_TOOLS = new Set(['Bash']);" },
  { id: 'C9', file: 'model', desc: 'the budget never reaches the panel',
    find: '      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,',
    repl: '      profile: m.profile || null, workdir: m.workdir || null, budget: null,' },
  { id: 'C10', file: 'model', desc: 'the workdir never reaches the panel',
    find: '      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,',
    repl: '      profile: m.profile || null, workdir: null, budget: m.budget || null,' },
  { id: 'C11', file: 'model', desc: 'narrow tools silently dropped',
    find: "    narrow: inherits ? [] : effective.filter(t => !BROAD_TOOLS.has(t)),",
    repl: '    narrow: [],' },

  { id: 'C12', file: 'model', desc: 'every deny entry reported as a no-op, including the ones that bit',
    find: "    denyNoop: inherits ? [] : [...denied].filter(t => !tools.includes(t)),",
    repl: '    denyNoop: [...denied],' },
  { id: 'C13', file: 'model', desc: 'hasBroad hard-wired true — a warning on every agent teaches the reader to ignore it',
    find: '    hasBroad: broad.length > 0,', repl: '    hasBroad: true,' },
  { id: 'C14', file: 'model', desc: 'an explicit empty tools list read as inheritance',
    find: '  const inherits = rawTools == null || malformedTools;',
    repl: '  const inherits = !tools || !tools.length;' },
  { id: 'C15', file: 'model', desc: 'an inheriting agent given an invented concrete tool list',
    find: "    narrow: inherits ? [] : effective.filter(t => !BROAD_TOOLS.has(t)),",
    repl: '    narrow: inherits ? [...BROAD_TOOLS] : effective.filter(t => !BROAD_TOOLS.has(t)),' },
  { id: 'C16', file: 'model', desc: 'the comma-separated string form of tools: no longer split',
    find: "  : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean)",
    repl: "  : typeof v === 'string' ? [v]" },
  { id: 'C17', file: 'model', desc: 'trigger types dropped entirely',
    find: "      triggerTypes: rawTrig.map(t => (t && typeof t === 'object' && typeof t.type === 'string') ? t.type : 'unknown'),",
    repl: '      triggerTypes: [],' },
  { id: 'C18', file: 'model', desc: 'webhookArmed never determined, even when the caller determined it',
    find: "      webhookArmed: typeof opts.webhookArmed === 'boolean' ? opts.webhookArmed : null,",
    repl: '      webhookArmed: null,' },

  // --- the panel: the sentences, and the order they are met in -------------------------------
  // V1 does not delete anything; it puts a tool list ABOVE the warning, which is precisely the
  // layout the brief rules out. Only the order assertion can notice.
  { id: 'V1', file: 'view', desc: 'a tool list rendered above the shell warning',
    find: '    <h2>What this agent can do</h2>\n    ${c.hasBroad',
    repl: '    <h2>What this agent can do</h2>\n    <p class="muted">Tools: ${c.effective.join(\', \')}</p>\n    ${c.hasBroad' },
  { id: 'V2', file: 'view', desc: 'an unreadable budget rendered as a hard $0.00 cap',
    find: "const money = n => (typeof n === 'number' && Number.isFinite(n)) ? usd(n) : 'an unknown amount';",
    repl: 'const money = n => usd(n);' },
  { id: 'V3', file: 'view', desc: 'an unreadable turn cap rendered as 0',
    find: "const count = n => (typeof n === 'number' && Number.isFinite(n)) ? String(n) : 'an unknown number of';",
    repl: 'const count = n => String(+n || 0);' },
  { id: 'V4', file: 'view', desc: 'an unreadable agent file renders nothing at all',
    find: '  if (!c) {', repl: '  if (!c) { return null; }\n  if (false) {' },
  { id: 'V5', file: 'view', desc: 'the workdir presented as a boundary, with no caveat',
    find: ' — the directory it starts in, not a boundary it is\n        held to.', repl: '.' },
  { id: 'V6', file: 'view', desc: 'the profile presented as an identity boundary',
    find: ' — a Claude profile, which selects an account and\n        its subscription. Every agent on this box runs under the same OS login and can reach the\n        same files, so this is not an identity boundary.',
    repl: '.' },
  { id: 'V7', file: 'view', desc: 'the daily cap stated without saying when it is checked',
    find: ' — the daily cap is checked before a run\n              starts, so it does not stop a run already under way',
    repl: '' },
  { id: 'V8', file: 'view', desc: 'the webhook sentence shown unconditionally',
    find: '    ${p.webhookArmed && html`<p class="cap-warn">A webhook secret is configured',
    repl: '    ${true && html`<p class="cap-warn">A webhook secret is configured' },
  { id: 'V9', file: 'view', desc: 'an inheriting agent described as having no tools',
    find: 'Tools: <b>every tool</b>', repl: 'Tools: <b>none</b>' },
  { id: 'V10', file: 'view', desc: 'the no-op deny list is not mentioned',
    find: '    ${!!c.denyNoop.length && html', repl: '    ${false && html' },
  { id: 'V11', file: 'view', desc: 'Task-only authority described as a shell',
    find: "    ${c.hasBroad && (c.broad.includes('Bash')", repl: '    ${c.hasBroad && (true' },
  // The two spacing mutations reproduce htm's newline trimming exactly rather than deleting the
  // character: wrapping a sentence right after a closing tag is how this file loses a space in
  // practice, and it is what a browser caught that flat-text assertions had waved through.
  { id: 'V20', file: 'view', desc: 'the sentence wrapped right after the bold clause (htm eats the space)',
    find: "</b>${' '}It can read and\n          write any file",
    repl: '</b>\n          It can read and write any file' },
  { id: 'V21', file: 'view', desc: 'the deny-list sentence wrapped right after the code element',
    find: "<code>disallowedTools</code>${' '}names ${c.denyNoop.join(', ')},\n      which removes nothing",
    repl: "<code>disallowedTools</code>\n      names ${c.denyNoop.join(', ')}, which removes nothing" },
  { id: 'V22', file: 'view', desc: 'the subagent sentence wrapped right after the bold clause',
    find: "</b>${' '}A subagent carries its\n          own tool list",
    repl: '</b>\n          A subagent carries its own tool list' },
  { id: 'V19', file: 'view', desc: 'the shell warning shown for every agent, whatever its tools',
    find: "    ${c.hasBroad && (c.broad.includes('Bash')", repl: '    ${true && (true' },
  { id: 'V12', file: 'view', desc: 'agent-controlled text put into an ATTRIBUTE instead of a text node',
    find: '      <li>in <b>${p.workdir || \'unknown\'}</b>',
    repl: "      <li title=${p.workdir || 'unknown'}>in <b>${p.workdir || 'unknown'}</b>" },
  { id: 'V13', file: 'view', desc: 'the tool list rendered through dangerouslySetInnerHTML',
    find: "      : html`<p class=\"muted\">Tools: ${c.effective.join(', ') || 'none'}</p>`}",
    repl: "      : html`<p class=\"muted\" dangerouslySetInnerHTML=${{ __html: 'Tools: ' + (c.effective.join(', ') || 'none') }}></p>`}" },
  { id: 'V14', file: 'view', desc: 'an element this file never audited appears in the tree',
    find: "      <li>runs as <b>${p.profile || 'unknown'}</b>",
    repl: "      <li>runs as <iframe>${p.profile || 'unknown'}</iframe>" },
  { id: 'V15', file: 'view', desc: 'the unknown panel stops telling the reader to assume unrestricted',
    find: 'Assume it is unrestricted until you have read the file yourself.', repl: 'Nothing to report.' },
  { id: 'V16', file: 'view', desc: 'the warning stops saying the tool list does not bound it',
    find: '          write any file this account can reach, regardless of the tool list below.</p>`',
    repl: '          write files.</p>`' },
  { id: 'V18', file: 'view', desc: 'a daily cap asserted for a file that declares none',
    find: '        b.usd_per_day != null', repl: '        true' },
  { id: 'V17', file: 'view', desc: 'the chat-budget caveat dropped and the per-run cap stated flatly',
    find: '. Chat turns below are capped separately by mows-agent and are not covered by the\n        per-run figure.', repl: '.' },

  // --- the check's OWN tree walker ------------------------------------------------------------
  // A walker that quietly stopped walking would carry every text and prop assertion green — the
  // same failure mode chat-view-coverage.mjs guards with its D-series.
  { id: 'W1', file: 'check', desc: 'the walker stops descending into the tree',
    find: '  if (node == null || typeof node === \'boolean\') return;',
    repl: '  if (node == null || typeof node === \'boolean\' || true) return;' },
  { id: 'W2', file: 'check', desc: 'the walker stops collecting props (a detector that detects nothing)',
    find: "  walk(node, v => { if (v.props) for (const [k, val] of Object.entries(v.props)) out.push([k, val]); });",
    repl: '  walk(node, () => {});' },
  { id: 'W3', file: 'check', desc: 'the walker stops collecting tags',
    find: "function tagsOf(node) { const out = []; walk(node, v => { if (v.tag) out.push(v.tag); }); return out; }",
    repl: 'function tagsOf(node) { walk(node, () => {}); return []; }' },

  // --- the validator the model is fed by -------------------------------------------------------
  // The [integration] section's claim is "these two agree about a real file". Only breaking the
  // parser can redden the parse assertion, so break it.
  { id: 'P1', file: 'meta', desc: 'mows-agent-meta json stops emitting JSON',
    find: '        json.dump(fm, sys.stdout, default=str)',
    repl: '        sys.stdout.write("not json")' },
];

const read = f => readFileSync(FILES[f], 'utf8');
const write = (f, s) => writeFileSync(FILES[f], s);

function runCheck() {
  try { return execFileSync(process.execPath, [CHECK], { encoding: 'utf8', cwd: ROOT }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
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
      if (!before.includes(m.find)) { broken.push(`${m.id}: FAILED TO APPLY — target text not found (moved?)`); continue; }
      if (before.split(m.find).length - 1 !== 1) {
        broken.push(`${m.id}: FAILED TO APPLY — target text is ambiguous (${before.split(m.find).length - 1} matches)`); continue;
      }
      const mutated = before.replace(m.find, m.repl);
      if (mutated === before) { broken.push(`${m.id}: CHANGED NOTHING`); continue; }
      write(m.file, mutated);
      const out = runCheck();
      const seen = new Set([...names(out, 'PASS'), ...names(out, 'FAIL')]);
      // A mutation that makes the check THROW stops it dead, and every assertion after the throw
      // goes unobserved — not green, unobserved. Three buckets would score that as a mutation
      // nothing noticed and keep printing "all mutations applied"; two of the first mutations
      // written for this file did exactly that. An incomplete run poisons the sweep instead.
      const missed = [...all].filter(n => !seen.has(n));
      if (missed.length) broken.push(`${m.id}: INCOMPLETE — the check died after ${seen.size}/${all.size} assertions (${missed.length} unobserved)`);
      for (const n of names(out, 'FAIL')) everRed.add(n);
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
  // Prove this tool can fail in each of the three ways it can be blind, exactly as
  // chat-view-coverage.mjs does — otherwise the three-way accounting is itself an unverified claim.
  let bad = 0;
  const expect = (label, cond, detail) => {
    console.log((cond ? 'PASS' : 'FAIL') + ': ' + label);
    if (!cond) { bad = 1; console.log('   got: ' + JSON.stringify(detail)); }
  };

  const a = sweep([{ id: 'ZZ', file: 'view', desc: 'target that does not exist',
    find: 'this text is not in the file and never was', repl: 'x' }]);
  expect('a mutation whose target has moved is reported, not absorbed',
    a.broken.some(b => b.includes('FAILED TO APPLY')), a.broken);

  const b = sweep([{ id: 'ZZ', file: 'view', desc: 'no-op',
    find: 'export function CapabilityPanel({ capability: c }) {',
    repl: 'export function CapabilityPanel({ capability: c }) {' }]);
  expect('a mutation that changes nothing is reported, not absorbed',
    b.broken.some(x => x.includes('CHANGED NOTHING')), b.broken);

  // The fourth bucket, which chat-view-coverage.mjs does not have and this file needed: a mutation
  // that kills the check part-way leaves most assertions UNOBSERVED, and a three-bucket tool scores
  // that as "nothing noticed" while printing "all mutations applied".
  const cr = sweep([{ id: 'ZZ', file: 'view', desc: 'the panel throws part-way through the run',
    find: 'export function CapabilityPanel({ capability: c }) {',
    repl: "export function CapabilityPanel({ capability: c }) { if (c && c.inherits) throw new Error('boom');" }]);
  expect('a mutation that kills the check part-way is reported, not scored as coverage',
    cr.broken.some(x => x.includes('INCOMPLETE')), cr.broken);

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
  expect('all files restored byte-identically',
    Object.keys(FILES).every(k => k !== 'check' || read(k) === orig), 'check file differs');
  process.exit(bad);
}

process.exit(report(sweep(MUTATIONS)));
