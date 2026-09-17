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
  fixture: path.join(ROOT, 'scripts/fixtures/inherited-tools.json'),
};
const CHECK = FILES.check;

// Each mutation is a literal find/replace against one file, written out rather than generated so
// the next person can read exactly what "proven able to fail" was proven against.
const MUTATIONS = [
  // --- the model: what it means to compute capability from the wrong thing --------------------
  // C1 makes the model read the DENY list as capability — the exact inversion the panel exists to
  // prevent. It adds rather than merely failing to subtract, so "Write never appears" can go red.
  { id: 'C1', file: 'model', desc: 'the deny list read as capability instead of subtracted from it',
    find: '  const effective = inherits ? null : tools.filter(t => !denied.has(t));',
    repl: '  const effective = inherits ? null : tools.concat([...denied]);' },
  { id: 'C2', file: 'model', desc: 'hasBroad hard-wired false — the "read-only" lie this task exists to stop',
    find: '    hasBroad: broad.length > 0,', repl: '    hasBroad: false,' },
  { id: 'C3', file: 'model', desc: 'inheritance computed but never reported (the panel sees an empty tool list)',
    find: '    inherits,', repl: '    inherits: false,' },
  { id: 'C4', file: 'model', desc: 'an unparseable tools: field collapses to the empty list (rounds toward restricted)',
    find: '  : null;', repl: '  : [];' },
  // The two shapes the Task 9 fuzz pass found. C27 restores the pre-fuzz array branch, under which
  // `tools: ['Bash ']` reads as an unclassified tool and `- Bash:` reads as "[object Object]";
  // C28 restores the version that called a list naming nothing at all a restriction.
  { id: 'C27', file: 'model', desc: 'the tools list parsed with v.map(String) again (no trim, non-strings coerced)',
    find: "  ? (v.every(x => typeof x === 'string') ? v.map(s => s.trim()).filter(Boolean) : null)\n",
    repl: '  ? v.map(String)\n' },
  { id: 'C28', file: 'model', desc: 'a list that names something and yields no tool is read as a restriction',
    find: ' || emptyToolString || emptyToolList;', repl: ' || emptyToolString;' },
  { id: 'C5', file: 'model', desc: 'the no-op deny list is no longer reported as one',
    find: "    denyNoop: inherits ? [] : [...denied].filter(t => !tools.includes(t)),",
    repl: '    denyNoop: [],' },
  { id: 'C6', file: 'model', desc: 'trigger types read straight off raw YAML (undefined reaches the panel)',
    find: "      triggerTypes,", repl: '      triggerTypes: rawTrig.map(t => String(t?.type)),' },
  { id: 'C7', file: 'model', desc: 'webhookArmed defaults to false — an undetermined answer stated as "no"',
    find: "      webhookArmed: typeof opts.webhookArmed === 'boolean' ? opts.webhookArmed : null,",
    repl: '      webhookArmed: !!opts.webhookArmed,' },
  { id: 'C8', file: 'model', desc: 'Task dropped from AUTHORITIES — the linter would then be stricter than the panel',
    find: "  { kind: 'subagent', beyondList: true, tools: ['Task'] },\n", repl: '' },
  { id: 'C9', file: 'model', desc: 'the budget never reaches the panel',
    find: '      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,',
    repl: '      profile: m.profile || null, workdir: m.workdir || null, budget: null,' },
  { id: 'C10', file: 'model', desc: 'the workdir never reaches the panel',
    find: '      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,',
    repl: '      profile: m.profile || null, workdir: null, budget: m.budget || null,' },
  { id: 'C11', file: 'model', desc: 'narrow tools silently dropped',
    find: "    narrow: inherits ? null : effective.filter(t => !broad.includes(t)),",
    repl: '    narrow: null,' },
  { id: 'C12', file: 'model', desc: 'every deny entry reported as a no-op, including the ones that bit',
    find: "    denyNoop: inherits ? [] : [...denied].filter(t => !tools.includes(t)),",
    repl: '    denyNoop: [...denied],' },
  { id: 'C13', file: 'model', desc: 'hasBroad hard-wired true — a warning on every agent teaches the reader to ignore it',
    find: '    hasBroad: broad.length > 0,', repl: '    hasBroad: true,' },
  { id: 'C14', file: 'model', desc: 'an explicit empty tools list read as inheritance',
    find: '  const inherits = rawTools == null || malformedTools;',
    repl: '  const inherits = !tools || !tools.length;' },
  { id: 'C15', file: 'model', desc: 'an inheriting agent reports a concrete empty tool list again (the round-1 shape)',
    find: '  const effective = inherits ? null : tools.filter(t => !denied.has(t));',
    repl: '  const effective = inherits ? [] : tools.filter(t => !denied.has(t));' },
  { id: 'C16', file: 'model', desc: 'the comma-separated string form of tools: no longer split',
    find: "  : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean)",
    repl: "  : typeof v === 'string' ? [v]" },
  { id: 'C17', file: 'model', desc: 'trigger types dropped entirely',
    find: "      triggerTypes,", repl: '      triggerTypes: [],' },
  { id: 'C18', file: 'model', desc: 'webhookArmed never determined, even when the caller determined it',
    find: "      webhookArmed: typeof opts.webhookArmed === 'boolean' ? opts.webhookArmed : null,",
    repl: '      webhookArmed: null,' },
  // C19-C20 are the round-1 model, restored: only beyond-the-list authority counted, and the
  // inherit path computing authority from `effective` (which is null there) rather than from the
  // deny list. Between them they reproduce both inversions this round exists to fix.
  { id: 'C19', file: 'model', desc: 'only beyond-the-list authority counted — writes and network go unnamed again',
    find: '    .filter(a => a.tools.length);', repl: '    .filter(a => a.tools.length && a.beyondList);' },
  { id: 'C20', file: 'model', desc: 'an inheriting agent reported as holding no authority at all',
    find: '      tools: inherits ? a.tools.filter(t => !denied.has(t)) : a.tools.filter(t => effective.includes(t)) }))',
    repl: '      tools: inherits ? [] : a.tools.filter(t => effective.includes(t)) }))' },
  { id: 'C21', file: 'model', desc: 'permissionMode read but never reported',
    find: "      permissionMode: typeof fm?.permissionMode === 'string' ? fm.permissionMode : null,",
    repl: '      permissionMode: null,' },
  { id: 'C22', file: 'model', desc: 'miscased tool names never reported',
    find: '    miscasedTools: inherits ? [] : effective.filter(t =>',
    repl: '    miscasedTools: [].filter(t =>' },
  { id: 'C23', file: 'model', desc: 'an unreadable deny list silently treated as empty (the round-1 behaviour)',
    find: '  const malformedDenied = rawDenied != null && deniedList === null;',
    repl: '  const malformedDenied = false;' },
  { id: 'C24', file: 'model', desc: 'a declared-but-inert webhook trigger is not disclosed',
    find: "      webhookDeclaredInert: opts.webhookArmed === false && triggerTypes.includes('webhook'),",
    repl: '      webhookDeclaredInert: false,' },
  { id: 'C25', file: 'model', desc: 'miscasing detector widened to flag every unfamiliar tool name',
    find: '      !AUTH_TOOLS.includes(t) && AUTH_TOOLS.some(k => k.toLowerCase() === String(t).toLowerCase())),',
    repl: '      !AUTH_TOOLS.includes(t)),' },
  { id: 'C26', file: 'model', desc: 'BROAD_TOOLS hardcoded instead of derived from AUTHORITIES',
    find: 'export const BROAD_TOOLS = new Set(AUTHORITIES.filter(a => a.beyondList).flatMap(a => a.tools));',
    repl: "export const BROAD_TOOLS = new Set(['Bash', 'Task']);" },

  // --- the panel: the sentences, and the order they are met in -------------------------------
  // V1 does not delete anything; it puts a tool list ABOVE the warning, which is precisely the
  // layout the brief rules out. Only the order assertions can notice.
  { id: 'V1', file: 'view', desc: 'a tool list rendered above the authority warnings',
    find: '    <h2>What this agent can do</h2>\n    ${!!auth.length',
    repl: '    <h2>What this agent can do</h2>\n    <p class="muted">Tools: ${c.effective}</p>\n    ${!!auth.length' },
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
    find: '    ${!!c.denyNoop?.length && html', repl: '    ${false && html' },
  { id: 'V11', file: 'view', desc: 'every authority rendered with the shell sentence',
    find: "  shell: ['This agent can run shell commands.',", repl: "  shellUNUSED: ['x', 'y'],\n  shell: ['This agent can run shell commands.'," },
  // The two spacing mutations reproduce htm's newline trimming exactly rather than deleting the
  // character: wrapping a sentence right after a closing tag is how this file loses a space in
  // practice, and it is what a browser caught that flat-text assertions had waved through.
  { id: 'V20', file: 'view', desc: 'the authority sentences wrapped so htm eats the space after the bold clause',
    find: "<b>${AUTHORITY_TEXT[a.kind][0]}</b>${' '}${AUTHORITY_TEXT[a.kind][1]}",
    repl: '<b>${AUTHORITY_TEXT[a.kind][0]}</b>\n          ${AUTHORITY_TEXT[a.kind][1]}' },
  { id: 'V21', file: 'view', desc: 'the deny-list sentence wrapped right after the code element',
    find: "<code>disallowedTools</code>${' '}names ${c.denyNoop.join(', ')},\n      which removes nothing",
    repl: "<code>disallowedTools</code>\n      names ${c.denyNoop.join(', ')}, which removes nothing" },
  { id: 'V19', file: 'view', desc: 'the authority block shown for every agent, whatever its tools',
    find: '    ${!!auth.length && html`<div class="cap-warn">', repl: '    ${true && html`<div class="cap-warn">' },
  { id: 'V12', file: 'view', desc: 'agent-controlled text put into an ATTRIBUTE instead of a text node',
    find: "      <li>in <b>${p.workdir || 'unknown'}</b>",
    repl: "      <li title=${p.workdir || 'unknown'}>in <b>${p.workdir || 'unknown'}</b>" },
  { id: 'V13', file: 'view', desc: 'the tool list rendered through dangerouslySetInnerHTML',
    find: "      : html`<p class=\"muted\">Tools its file grants: ${c.effective ? (c.effective.join(', ') || 'none') : 'unknown'}</p>`}",
    repl: "      : html`<p class=\"muted\" dangerouslySetInnerHTML=${{ __html: 'Tools its file grants: ' + (c.effective || []).join(', ') }}></p>`}" },
  { id: 'V14', file: 'view', desc: 'an element this file never audited appears in the tree',
    find: "      <li>runs as <b>${p.profile || 'unknown'}</b>",
    repl: "      <li>runs as <iframe>${p.profile || 'unknown'}</iframe>" },
  { id: 'V15', file: 'view', desc: 'the unknown panel stops telling the reader to assume unrestricted',
    find: 'Assume it is unrestricted until you have read the file yourself.', repl: 'Nothing to report.' },
  { id: 'V16', file: 'view', desc: 'the shell sentence stops saying the tool list does not bound it',
    find: "    'It can read and write any file this account can reach, regardless of the tool list below.'],",
    repl: "    'It is a broad agent.'],"},
  { id: 'V17', file: 'view', desc: 'the chat caveat dropped',
    find: '. A chat turn below is capped separately by mows-agent and is not covered by the\n        per-run figure; it carries this same tool list (measured, not assumed).', repl: '.' },
  // V23-V30: the round-1 sentences this round added, each deleted in turn.
  { id: 'V23', file: 'view', desc: 'the summary line reverts to naming the directory as a constraint',
    find: '    <p class="muted">What constrains it is its account, its budget, its triggers and the permission\n      rules of its profile — not the tool list, and not the directory.</p>',
    repl: '    <p class="muted">What actually constrains it is its account, directory, budget and triggers —\n      not the tool list.</p>' },
  { id: 'V24', file: 'view', desc: 'the permissionMode policy line removed',
    find: '      <li>under <b>permissionMode: ${p.permissionMode || \'not set\'}</b>, as written in its file.\n        This page reports what it read; it cannot check what the CLI does with it.</li>\n',
    repl: '' },
  { id: 'V25', file: 'view', desc: 'the "what this page cannot see" disclosure removed',
    find: '    <p class="muted">What this page cannot see: the profile\'s permission rules, any${\' \'}\n      <code>PreToolUse</code> hook (<code>agents/SETUP.md</code> makes a write-deny hook a\n      precondition for a shell-capable agent), and any MCP server <code>mows-agent</code> passes in.\n      Each can remove authority listed above. The CLI also decides the final tool set, and in every\n      run measured on this box it granted a subset of what the file declared — <code>Glob</code>${\' \'}\n      and <code>Grep</code> reached only the one agent that named them without <code>Bash</code>.\n      A file\'s <code>disallowedTools</code> was honoured in every case measured here: three tools\n      across both paths, each removing exactly itself and nothing else.</p>\n', repl: '' },
  { id: 'V26', file: 'view', desc: 'a permissionMode: plan agent gets the warning unqualified',
    find: '      ${planned && html`<p>Its file sets', repl: '      ${false && html`<p>Its file sets' },
  { id: 'V28', file: 'view', desc: 'a declared-but-inert webhook trigger is not mentioned',
    find: '    ${p.webhookDeclaredInert && html', repl: '    ${false && html' },
  { id: 'V29', file: 'view', desc: 'the miscased-tool sentence removed',
    find: '    ${!!c.miscasedTools?.length && html', repl: '    ${false && html' },
  { id: 'V30', file: 'view', desc: 'the unreadable-deny-list sentence removed',
    find: '    ${c.malformedDenied && html', repl: '    ${false && html' },
  { id: 'V31', file: 'view', desc: 'the write authority described as something else entirely',
    find: "  write: ['This agent can write files.',", repl: "  write: ['This agent has some tools.'," },
  { id: 'V32', file: 'view', desc: 'the network authority described as something else entirely',
    find: "  network: ['This agent can reach the network.',", repl: "  network: ['This agent has some tools.'," },
  { id: 'V33', file: 'view', desc: 'the authority list stops naming the tools that confer each kind',
    find: "${' '}<span class=\"muted\">(${a.tools.join(', ')})</span>", repl: '' },

  { id: 'C31', file: 'model', desc: 'the second turn limit is never read, so a disagreement cannot be seen',
    find: '      maxTurnsDeclared: (Number.isInteger(fm?.maxTurns) && fm.maxTurns > 0) ? fm.maxTurns : null,',
    repl: '      maxTurnsDeclared: null,' },
  { id: 'C32', file: 'model', desc: 'the turn limits are never compared',
    find: '      turnCapDisagreement: Number.isInteger(fm?.maxTurns) && Number.isInteger(m.budget?.max_turns)\n        && fm.maxTurns !== m.budget.max_turns,',
    repl: '      turnCapDisagreement: false,' },
  { id: 'C33', file: 'model', desc: 'agreeing turn limits reported as a disagreement (cries wolf)',
    find: '      turnCapDisagreement: Number.isInteger(fm?.maxTurns) && Number.isInteger(m.budget?.max_turns)\n        && fm.maxTurns !== m.budget.max_turns,',
    repl: '      turnCapDisagreement: Number.isInteger(fm?.maxTurns),' },
  { id: 'C34', file: 'model', desc: 'a malformed maxTurns accepted as a declared figure',
    find: '      maxTurnsDeclared: (Number.isInteger(fm?.maxTurns) && fm.maxTurns > 0) ? fm.maxTurns : null,',
    repl: '      maxTurnsDeclared: fm?.maxTurns ?? null,' },
  { id: 'V36', file: 'view', desc: 'the turn-limit disagreement is computed but never shown',
    find: '${p.turnCapDisagreement\n          ? html` Its file also sets', repl: '${false\n          ? html` Its file also sets' },

  { id: 'C35', file: 'model', desc: 'a lone mows turn figure reported as a disagreement',
    find: '      turnCapDisagreement: Number.isInteger(fm?.maxTurns) && Number.isInteger(m.budget?.max_turns)\n        && fm.maxTurns !== m.budget.max_turns,',
    repl: '      turnCapDisagreement: Number.isInteger(m.budget?.max_turns),' },
  // --- the fourth member of the quiet-state class, and its generalisation ----------------------
  { id: 'C36', file: 'model', desc: 'mcp__ tools no longer collected — the silence the lead found',
    find: '    mcpTools: inherits ? null : effective.filter(t => MCP_RE.test(t)),',
    repl: '    mcpTools: inherits ? null : [],' },
  { id: 'C37', file: 'model', desc: 'unclassified tools no longer reported',
    find: '    unclassifiedTools: inherits ? null\n      : effective.filter(t => !AUTH_TOOLS.includes(t) && !BENIGN_TOOLS.has(t) && !MCP_RE.test(t)),',
    repl: '    unclassifiedTools: inherits ? null : [],' },
  { id: 'C38', file: 'model', desc: 'the benign list dropped, so read-only tools are flagged unknown (cries wolf)',
    find: "const BENIGN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'BashOutput', 'ExitPlanMode']);",
    repl: 'const BENIGN_TOOLS = new Set([]);' },
  { id: 'C39', file: 'model', desc: 'mcp__ tools double-counted as unclassified as well',
    find: '      : effective.filter(t => !AUTH_TOOLS.includes(t) && !BENIGN_TOOLS.has(t) && !MCP_RE.test(t)),',
    repl: '      : effective.filter(t => !AUTH_TOOLS.includes(t) && !BENIGN_TOOLS.has(t)),' },
  { id: 'C40', file: 'model', desc: 'an authority tool also reported as unclassified',
    find: '      : effective.filter(t => !AUTH_TOOLS.includes(t) && !BENIGN_TOOLS.has(t) && !MCP_RE.test(t)),',
    repl: '      : effective.filter(t => !BENIGN_TOOLS.has(t) && !MCP_RE.test(t)),' },
  { id: 'V37', file: 'view', desc: 'the MCP unknown-reach warning removed',
    find: '    ${!!c.mcpTools?.length && html', repl: '    ${false && html' },
  { id: 'V38', file: 'view', desc: 'the unclassified-tools warning removed',
    find: '    ${!!c.unclassifiedTools?.length && html', repl: '    ${false && html' },
  { id: 'V39', file: 'view', desc: 'the inherit path stops warning about tools it cannot name',
    find: '    ${c.inherits && html`<p class="cap-warn">Inheriting also brings every tool',
    repl: '    ${false && html`<p class="cap-warn">Inheriting also brings every tool' },
  { id: 'V40', file: 'view', desc: 'the reassuring sentence shown regardless of what is unknown (the round-1 quiet state)',
    find: '  const quiet = !auth.length && !c.inherits && !c.malformedTools && !c.malformedDenied\n    && !c.miscasedTools?.length && !c.mcpTools?.length && !c.unclassifiedTools?.length;',
    repl: '  const quiet = !auth.length;' },
  { id: 'V41', file: 'view', desc: 'the reassuring sentence never shown at all',
    find: '    ${quiet && html`<p class="muted">No tool it holds confers shell access',
    repl: '    ${false && html`<p class="muted">No tool it holds confers shell access' },
  { id: 'V42', file: 'view', desc: 'the measured disallowedTools finding dropped from the disclosure',
    find: "      A file's <code>disallowedTools</code> was honoured in every case measured here: three tools\n      across both paths, each removing exactly itself and nothing else.", repl: '' },
  { id: 'V43', file: 'view', desc: 'the corrected subset finding dropped from the disclosure',
    find: '      run measured on this box it granted a subset of what the file declared', repl: '      run measured on this box things happened' },

  // --- round 3: the deny list that carries the silence, and the pinned measurement -------------
  { id: 'C41', file: 'model', desc: 'a load-bearing deny entry is never reported as one',
    find: "    denyLoadBearing: inherits ? [] : [...denied].filter(t => tools.includes(t) && AUTH_TOOLS.includes(t)),",
    repl: '    denyLoadBearing: [],' },
  { id: 'C42', file: 'model', desc: 'every deny entry called load-bearing, including no-ops (cries wolf)',
    find: "    denyLoadBearing: inherits ? [] : [...denied].filter(t => tools.includes(t) && AUTH_TOOLS.includes(t)),",
    repl: '    denyLoadBearing: [...denied],' },
  { id: 'C43', file: 'model', desc: 'a denied non-authority tool counted as load-bearing',
    find: "    denyLoadBearing: inherits ? [] : [...denied].filter(t => tools.includes(t) && AUTH_TOOLS.includes(t)),",
    repl: '    denyLoadBearing: inherits ? [] : [...denied].filter(t => tools.includes(t)),' },
  { id: 'V46', file: 'view', desc: 'the deny-list disclosure loses its space (the htm newline-trim class again)',
    find: "which removes${' '}\n            ${c.denyLoadBearing.join(', ')}",
    repl: "which removes\n            ${c.denyLoadBearing.join(', ')}" },
  { id: 'V44', file: 'view', desc: 'the quiet panel stops saying the deny list is what made it quiet',
    find: '${c.denyLoadBearing?.length\n        ? html` That rests entirely on its', repl: '${false\n        ? html` That rests entirely on its' },
  { id: 'V45', file: 'view', desc: 'the deny-list disclosure shown even when the deny list did nothing',
    find: '${c.denyLoadBearing?.length\n        ? html` That rests entirely on its', repl: '${true\n        ? html` That rests entirely on its' },
  { id: 'F1', file: 'fixture', desc: 'the pinned measurement disappears from the tree',
    find: '"granted_tools"', repl: '"granted_tools_RENAMED"' },
  { id: 'F2', file: 'fixture', desc: 'the pinned tool set is edited without the panel copy following',
    find: '    "Bash",\n', repl: '' },
  { id: 'F3', file: 'fixture', desc: 'the fixture stops recording what it was measured against',
    find: '  "cli_version"', repl: '  "cli_version_REMOVED"' },
  { id: 'K1', file: 'check', desc: 'the quiet-clause derivation stops reading the view',
    find: "  const quietExpr = (viewSrc.match(/const quiet = ([\\s\\S]*?);\\n/) || [])[1] || '';",
    repl: "  const quietExpr = 'c.authorities c.inherits c.malformedTools c.malformedDenied c.miscasedTools c.mcpTools c.unclassifiedTools c.somethingNobodyCovered';" },
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

  // --- the validator the model is fed by and compared against ---------------------------------
  // P1 breaks the parser the model is fed by. P2 is the mutation round 1 could not fail: the
  // reviewer widened WRITE_CAPABLE_TOOLS and the check stayed 66/66 green, because the mirror
  // claim was asserted against a hardcoded literal instead of against this file.
  // The two detector mutations below break the CHECK's own missing-space detector, in each of the
  // two directions it can be wrong. A detector with no false-positive guard would flag every block
  // boundary in the panel and get deleted as noise the first time someone read its output.
  { id: 'W4', file: 'check', desc: 'the space detector loses its block-boundary guard (cries wolf)',
    find: "    else if (BLOCK.has(v.tag)) seq.push(null); // a break: nothing either side of it is adjacent",
    repl: '    else if (false) seq.push(null);' },
  { id: 'W5', file: 'check', desc: 'the space detector flags punctuation boundaries too',
    find: '    if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) bad.push',
    repl: '    if (/[^ ]$/.test(a) && /^[^ ]/.test(b)) bad.push' },
  { id: 'P1', file: 'meta', desc: 'mows-agent-meta json stops emitting JSON',
    find: '        json.dump(fm, sys.stdout, default=str)',
    repl: '        sys.stdout.write("not json")' },
  { id: 'P2', file: 'meta', desc: 'the linter hardens and the dashboard does not follow',
    find: 'WRITE_CAPABLE_TOOLS = {"Bash", "Task"}',
    repl: 'WRITE_CAPABLE_TOOLS = {"Bash", "Task", "WebFetch"}' },
  // --- the second pass: mutations for the assertions the first pass could not redden -----------
  { id: 'C27', file: 'model', desc: 'a well-formed deny list reported as unreadable',
    find: '  const malformedDenied = rawDenied != null && deniedList === null;',
    repl: '  const malformedDenied = rawDenied != null;' },
  { id: 'C28', file: 'model', desc: 'inertness inferred even when the secret was never looked up',
    find: "      webhookDeclaredInert: opts.webhookArmed === false && triggerTypes.includes('webhook'),",
    repl: "      webhookDeclaredInert: opts.webhookArmed !== true && triggerTypes.includes('webhook')," },
  { id: 'C29', file: 'model', desc: 'every kind of authority reported for every agent',
    find: '    .filter(a => a.tools.length);', repl: '    .filter(() => true);' },
  { id: 'C30', file: 'model', desc: 'an absent permissionMode guessed as "default" instead of reported as unset',
    find: "      permissionMode: typeof fm?.permissionMode === 'string' ? fm.permissionMode : null,",
    repl: "      permissionMode: typeof fm?.permissionMode === 'string' ? fm.permissionMode : 'default'," },
  { id: 'V18', file: 'view', desc: 'a daily cap asserted for a file that declares none',
    find: '        b.usd_per_day != null', repl: '        true' },
  { id: 'V34', file: 'view', desc: 'the plan qualifier shown for every agent',
    find: '      ${planned && html`<p>Its file sets', repl: '      ${true && html`<p>Its file sets' },
  { id: 'V35', file: 'view', desc: 'the plan qualifier triggered by a substring instead of the value',
    find: "  const planned = p.permissionMode === 'plan';",
    repl: "  const planned = String(p.permissionMode || '').includes('plan');" },
  { id: 'P3', file: 'meta', desc: 'WRITE_CAPABLE_TOOLS renamed, so the mirror check can no longer read it',
    find: 'WRITE_CAPABLE_TOOLS = {"Bash", "Task"}', repl: 'WRITE_CAPABLE_SET = {"Bash", "Task"}' },
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
  const passed = names(baseline, 'PASS');
  const all = new Set(passed);
  if (names(baseline, 'FAIL').length) {
    restore();
    return { fatal: 'the check does not pass on an unmutated tree; fix that before reading coverage',
      baselineFailures: names(baseline, 'FAIL') };
  }
  // This tool identifies assertions BY LABEL, so two assertions sharing one collapse into a single
  // Set entry and the second becomes invisible: it can be vacuous, or dead, and the sweep still
  // prints "NEVER RED: (none)" and exits 0. That happened — 134 assertions ran, 133 were accounted
  // for, and a planted `1 === 1` in the shadowed one went unreported (re-review R3).
  //
  // A tool built to catch "cannot see it, reports success" must not have that shape itself, so it
  // refuses to report a number it cannot stand behind rather than quietly de-duplicating.
  if (all.size !== passed.length) {
    const seen = new Set(), dupes = [...new Set(passed.filter(n => seen.has(n) || (seen.add(n), false)))];
    restore();
    return { fatal: `the check has ${passed.length - all.size} duplicate assertion label(s); `
      + 'each hides another assertion from this sweep. Rename them before reading coverage',
      baselineFailures: dupes.map(d => 'duplicate label: ' + d) };
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
  // Probe 5: the duplicate-label guard. Plant a duplicate in the check and confirm the sweep refuses
  // to report rather than silently de-duplicating — the failure that let a vacuous assertion hide.
  {
    const origCheck = read('check');
    try {
      write('check', origCheck.replace('process.exit(failed ? 1 : 0);',
        "check('[walker] finds text in the tree', true);\nprocess.exit(failed ? 1 : 0);"));
      const dup = sweep([]);
      expect('a duplicate assertion label is refused, not de-duplicated',
        !!dup.fatal && /duplicate assertion label/.test(dup.fatal), dup);
    } finally {
      write('check', origCheck);
    }
  }

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
