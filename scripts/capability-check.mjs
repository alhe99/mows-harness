// Persisted regression check for Task 8's capability panel — the claim that the panel states
// EFFECTIVE capability, never a restriction that nothing enforces, and never stays quiet about
// authority the agent holds.
//
// It exercises the SAME two units the dashboard runs, never a copy: agentCapability() from
// infra/dashboard/capability.mjs (which is why that function lives in its own module rather than
// inside lite.mjs — importing lite.mjs would start an HTTP listener), and CapabilityPanel() from
// infra/dashboard/app/views/capability.mjs. Precedent and reasoning: scripts/chat-view-check.mjs.
//
// The view is browser code importing bare specifiers the SERVER resolves through the inline import
// map in uiShellHtml(). Node has no import map, so the same resolve hook chat-view-check.mjs uses
// points those at app/vendor/* — the real preact and the real htm do the work here exactly as they
// do in the browser.
//
// THE PANEL IS NOT RENDERED TO A STRING. htm evaluates eagerly, so calling the component returns a
// fully materialised vnode tree, and asserting on that tree is stronger than asserting on markup:
// "the payload is a text CHILD, not a prop" is a question about the tree, and a string of HTML
// cannot answer it — which is the whole XSS question for this file.
//
// Requires Node >= 22.15 (node:module.registerHooks) and python3 with PyYAML for the two sections
// that read agents/bin/mows-agent-meta. Both FAIL rather than skip: a gate that quietly excuses
// itself reports green.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', pathToFileURL(import.meta.filename));
const APP = new URL('infra/dashboard/app/', ROOT);
if (typeof registerHooks !== 'function') {
  console.error('FAIL: node:module.registerHooks is unavailable — this check needs Node >= 22.15');
  process.exit(1);
}
const VENDOR = { preact: 'vendor/preact.mjs', 'preact/hooks': 'vendor/hooks.mjs', htm: 'vendor/htm.mjs', marked: 'vendor/marked.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    const rel = VENDOR[specifier];
    if (rel) return { url: new URL(rel, APP).href, shortCircuit: true };
    return next(specifier, context);
  },
});

const { agentCapability, BROAD_TOOLS, AUTHORITIES } = await import(new URL('infra/dashboard/capability.mjs', ROOT).href);
const { CapabilityPanel } = await import(new URL('views/capability.mjs', APP).href);

let failed = false;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
  if (!cond) { failed = true; if (detail !== undefined) console.log('  got: ' + JSON.stringify(detail)); }
}

// ---- walking the vnode tree -----------------------------------------------------------------
// A vnode is {type, props:{children,...}}. `type` is a string for an element. Children are vnodes,
// strings, numbers, arrays, or `false` (what `cond && html\`…\`` yields when cond is false).
function walk(node, visit) {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (typeof node !== 'object') { visit({ text: String(node) }); return; }
  const { children, ...rest } = node.props || {};
  visit({ tag: node.type, props: rest });
  walk(children, visit);
}
// Visible text in DOCUMENT ORDER — the order assertions below are about what a reader meets first,
// so a set would be the wrong shape.
function textOf(node) {
  const out = [];
  walk(node, v => { if (v.text !== undefined) out.push(v.text); });
  return out;
}
const flat = node => textOf(node).join(' ').replace(/\s+/g, ' ').trim();
// What the DOM actually concatenates: adjacent text nodes butt straight up against each other with
// no separator. flat() joins on a space and so is BLIND to a missing one — it scored
// "shell commands.It can read" as correct, and a browser showed it in the first screenshot taken of
// this panel. htm trims a static chunk that starts with a newline, which makes this the default
// failure mode of wrapping a sentence right after an interpolation or a closing tag.
const domText = node => textOf(node).join('').replace(/\s+/g, ' ');
// The whole missing-space CLASS, rather than one assertion per instance. htm trims a static chunk
// that begins OR ends with a newline, so any sentence wrapped next to an element or an
// interpolation can lose its space — three instances shipped in round 1 (two leading, one
// trailing, the last of which only a browser found). Wherever two adjacent text nodes meet, a word
// character must not run straight into another word character: that boundary is always either a
// missing space or a deliberate join, and this panel has no deliberate ones.
// BLOCK elements end a line of prose, so text either side of one needs no space between it and the
// next — only text meeting INSIDE a paragraph can be missing one. A flat walk that ignored that
// reported the <h2> running into the first <p> as a defect, which is how a detector earns a
// reputation for crying wolf and then gets deleted.
const BLOCK = new Set(['div', 'p', 'ul', 'li', 'h1', 'h2', 'h3']);
function joinedWords(node) {
  const seq = [];
  walk(node, v => {
    if (v.text !== undefined) seq.push(v.text);
    else if (BLOCK.has(v.tag)) seq.push(null); // a break: nothing either side of it is adjacent
  });
  const bad = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    if (a === null || b === null) continue;
    if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) bad.push(a.slice(-24) + '|' + b.slice(0, 24));
  }
  return bad;
}
function tagsOf(node) { const out = []; walk(node, v => { if (v.tag) out.push(v.tag); }); return out; }
function propsOf(node) { // [[name, value]] for every non-children prop in the tree
  const out = [];
  walk(node, v => { if (v.props) for (const [k, val] of Object.entries(v.props)) out.push([k, val]); });
  return out;
}
// Sanity-check the detector itself, so one that stopped detecting cannot carry the sweep below.
check('[detector] joinedWords flags two words run together inside one paragraph',
  joinedWords({ type: 'p', props: { children: ['the profile rules, any', 'PreToolUse hook'] } }).length === 1);
check('[detector] joinedWords does not flag an ordinary space or punctuation boundary',
  joinedWords({ type: 'p', props: { children: ['Tools: ', 'Read, Grep', ', which'] } }).length === 0);
check('[detector] joinedWords does not flag text either side of a block boundary',
  joinedWords({ type: 'div', props: { children: [
    { type: 'h2', props: { children: 'What this agent can do' } },
    { type: 'p', props: { children: 'This agent can run shell commands' } }] } }).length === 0);

// Sanity-check the walker in both directions, so a walker that quietly stopped walking cannot
// carry every assertion below green.
{
  const probe = CapabilityPanel({ capability: null });
  check('[walker] finds text in the tree', flat(probe).length > 20, flat(probe));
  check('[walker] finds element tags in the tree', tagsOf(probe).includes('p'), tagsOf(probe));
  check('[walker] finds props in the tree',
    propsOf(probe).some(([k, v]) => k === 'class' && v === 'cap-warn'), propsOf(probe));
}

// ---- fixtures: the real shapes, not convenient ones ------------------------------------------
const cap = (fm, opts) => agentCapability(fm, opts);
// harness-reviewer's exact frontmatter shape — the pair the brief calls the whole point: a deny
// list that looks restrictive next to a tools list that grants a shell.
const REVIEWER = {
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  disallowedTools: ['Write', 'Edit', 'WebFetch', 'NotebookEdit'],
  permissionMode: 'default',
  mows: { profile: 'default', workdir: '~/Documents/Projects/mows-harness',
    budget: { usd_per_run: 1.5, max_turns: 40, usd_per_day: 6, quota_floor: 30 },
    triggers: [{ type: 'cron', spec: '*-*-* 06:00:00' }] },
};
const kinds = c => (c.authorities || []).map(a => a.kind).join(',');

// ---- the model: effective capability, never the declared one ---------------------------------
{
  const c = cap(REVIEWER);
  check('a denied tool that was never granted is absent from effective',
    !c.effective.includes('Write'), c.effective);
  check('effective is the allow list, not the deny list',
    c.effective.join() === 'Read,Glob,Grep,Bash', c.effective);
  check('Bash in the tool list makes hasBroad true despite the deny list', c.hasBroad === true, c);
  check('the shell authority names the tool that confers it',
    kinds(c) === 'shell' && c.authorities[0].tools.join() === 'Bash', c.authorities);
  check('the deny list is reported as the no-op it is',
    c.denyNoop.join() === 'Write,Edit,WebFetch,NotebookEdit', c.denyNoop);
  // Optional chaining is not defensiveness for its own sake: scripts/capability-coverage.mjs
  // mutates the budget away, and an assertion that THROWS instead of failing takes every assertion
  // after it down with it — the mutation then buys no coverage at all and the sweep cannot tell
  // that from a mutation nothing noticed.
  check('policy carries the mows block through', c.policy.workdir === REVIEWER.mows.workdir
    && c.policy.profile === 'default' && c.policy.budget?.usd_per_run === 1.5, c.policy);
  check('permissionMode is read from the file', c.policy.permissionMode === 'default', c.policy);
  check('trigger types are flattened for the view', c.policy.triggerTypes.join() === 'cron', c.policy.triggerTypes);
}
{ // A genuinely narrow agent: no authority of any kind. The one shape a quiet panel is honest for.
  const c = cap({ tools: ['Read', 'Grep'], mows: { profile: 'default' } });
  check('an agent with no authority-conferring tool holds no authority',
    c.hasBroad === false && c.authorities.length === 0, c);
  check('its narrow tools are listed', c.narrow?.join() === 'Read,Grep', c.narrow);
  check('permissionMode absent reads as null, not as a guess', c.policy.permissionMode === null, c.policy);
}
{ // Deny lists that actually bite.
  const c = cap({ tools: ['Read', 'Bash'], disallowedTools: ['Bash'] });
  check('a denied tool that WAS granted is subtracted', c.effective.join() === 'Read', c.effective);
  check('denying the only broad tool clears hasBroad', c.hasBroad === false, c);
  check('a deny entry that actually bit is not reported as a no-op', c.denyNoop.length === 0, c.denyNoop);
}
{ // Task without Bash: the same authority one level down, and it must still be named.
  const c = cap({ tools: ['Read', 'Task'] });
  check('Task alone counts as broad', c.hasBroad === true && c.broad.join() === 'Task', c);
  check('and it is named as the subagent authority, not as a shell', kinds(c) === 'subagent', c.authorities);
}
// ---- the authorities round 1 never named (review F5) -----------------------------------------
{
  const c = cap({ tools: ['Read', 'Write', 'Edit', 'WebFetch'], mows: { profile: 'x' } });
  check('file-writing tools are named as authority', kinds(c).includes('write'), c.authorities);
  check('network tools are named as authority', kinds(c).includes('network'), c.authorities);
  check('...but neither exceeds the tool list, so hasBroad stays false', c.hasBroad === false, c);
  const t = flat(CapabilityPanel({ capability: c }));
  check('the panel says it can write files', /can write files/.test(t), t);
  check('the panel says it can reach the network', /can reach the network/.test(t), t);
  check('round 1 rendered this shape silent; it no longer does',
    /cap-warn/.test(JSON.stringify(propsOf(CapabilityPanel({ capability: c })))), t);
}
{
  const c = cap({ tools: ['Read', 'SlashCommand'] });
  check('SlashCommand is treated as reaching beyond the tool list',
    c.hasBroad === true && kinds(c) === 'command', c);
}
// ---- the fourth member of the quiet-state class: a tool whose reach is UNKNOWABLE --------------
// `tools: [Read, mcp__figma__get_screenshot]` rendered a panel identical to a genuinely read-only
// agent's. An MCP tool reaches whatever its server reaches, which is not knowable from its name.
{
  const c = cap({ tools: ['Read', 'mcp__figma__get_screenshot'] });
  check('an mcp__ tool is collected as unknown-reach', c.mcpTools.join() === 'mcp__figma__get_screenshot', c.mcpTools);
  check('...and is NOT silently counted as unclassified as well', c.unclassifiedTools.length === 0, c.unclassifiedTools);
  check('...and does not fabricate a known authority', c.authorities.length === 0 && c.hasBroad === false, c);
  const t = flat(CapabilityPanel({ capability: c }));
  check('the panel says its MCP reach is unknown', /reach through MCP is unknown/.test(t), t);
  check('...and refuses to guess in either direction', /will not guess in either direction/.test(t), t);
  check('an mcp__ tool does NOT print the reassuring sentence', !/read the rest of this panel/.test(t), t);
}
// The same rule, generalised: a tool this page has no classification for. The measurement that
// forced it — an inheriting agent was granted 27 tools and AUTHORITIES names 8 — means a fixed
// allowlist of dangerous names is permanently behind the real tool surface.
{
  const c = cap({ tools: ['Read', 'CronCreate', 'RemoteTrigger'] });
  check('tools outside both the authority and benign lists are reported as unclassified',
    c.unclassifiedTools.join() === 'CronCreate,RemoteTrigger', c.unclassifiedTools);
  const t = flat(CapabilityPanel({ capability: c }));
  check('the panel names them and calls their reach unknown',
    /cannot classify CronCreate, RemoteTrigger/.test(t) && /rather than as harmless/.test(t), t);
  check('an unclassified tool does NOT print the reassuring sentence', !/read the rest of this panel/.test(t), t);
  check('a read-only tool is not reported as unclassified',
    cap({ tools: ['Read', 'Glob', 'Grep'] }).unclassifiedTools.length === 0, cap({ tools: ['Read', 'Glob', 'Grep'] }));
  check('an authority tool is not ALSO reported as unclassified',
    cap({ tools: ['Bash', 'Write'] }).unclassifiedTools.length === 0, cap({ tools: ['Bash', 'Write'] }));
}
// ---- the audit: the quiet state is reachable ONLY through the one path that is honest ----------
// Enumerated rather than spot-checked. Each entry is a way an agent could hold real authority; the
// panel must stay noisy for all of them, and may be quiet only for the last.
{
  const paths = {
    'missing tools: key (round 1)': { mows: {} },
    'deny list on the inherit path (round 2, F3)': { disallowedTools: ['Bash', 'Task'] },
    'inherit + every KNOWN authority denied': { disallowedTools: ['Bash', 'Task', 'SlashCommand', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'] },
    'a populated list of writing and network tools (F5)': { tools: ['Read', 'Write', 'Edit', 'WebFetch'] },
    'an mcp__ tool (round 2, the lead)': { tools: ['Read', 'mcp__db__query'] },
    'a tool this page has no name for': { tools: ['Read', 'CronCreate'] },
    'an unparseable tools: field': { tools: 42 },
    'an unparseable disallowedTools': { tools: ['Read'], disallowedTools: 42 },
    'a miscased authority tool': { tools: ['Read', 'bash'] },
    // R2: an empty or comma-only tools STRING collapses to [] and rendered "grants: none".
    'an empty tools string': { tools: '' },
    'a comma-only tools string': { tools: ', ,' },
  };
  let leaked = null;
  for (const [label, fm] of Object.entries(paths)) {
    const t = flat(CapabilityPanel({ capability: cap(fm) }));
    if (/read the rest of this panel/.test(t)) leaked = { label, t };
  }
  check('[audit] no path that hides real authority reaches the reassuring quiet state',
    leaked === null, leaked);
  // ...and the honest quiet state is still reachable, or the assertion above would be vacuous.
  const t = flat(CapabilityPanel({ capability: cap({ tools: ['Read', 'Glob', 'Grep'], mows: { profile: 'x' } }) }));
  check('[audit] a genuinely read-only agent still gets the quiet panel',
    /read the rest of this panel/.test(t), t);

  // DERIVED, not maintained by hand. `paths` above is nine-plus cases somebody thought of, and the
  // re-review found two more by trying — so a hand-kept list is a spot-check wearing an
  // enumeration's clothes. `quiet` is one boolean expression in the view, and every clause of it is
  // a way to be non-quiet; reading the clauses OUT of the view and requiring a fixture for each is
  // what makes completeness checkable. Add a clause to `quiet` without a fixture and this reddens.
  const viewSrc = readFileSync(new URL('views/capability.mjs', APP).pathname, 'utf8');
  const quietExpr = (viewSrc.match(/const quiet = ([\s\S]*?);\n/) || [])[1] || '';
  const clauses = [...new Set([...quietExpr.matchAll(/c\.([A-Za-z]+)/g)].map(m => m[1]))].sort();
  // One fixture per clause, each chosen so THAT clause alone is what makes it non-quiet.
  const byClause = {
    authorities: { tools: ['Read', 'Bash'] },
    inherits: { mows: {} },
    malformedTools: { tools: 42 },
    malformedDenied: { tools: ['Read'], disallowedTools: 42 },
    miscasedTools: { tools: ['Read', 'bash'] },
    mcpTools: { tools: ['Read', 'mcp__x__y'] },
    unclassifiedTools: { tools: ['Read', 'CronCreate'] },
  };
  check('[audit] the quiet condition was readable out of the view', clauses.length >= 6, { quietExpr, clauses });
  const uncovered = clauses.filter(k => !(k in byClause));
  check('[audit] every clause of `quiet` has a fixture that trips it', uncovered.length === 0,
    { clauses, uncovered });
  const notTripped = Object.entries(byClause)
    .filter(([, fm]) => /read the rest of this panel/.test(flat(CapabilityPanel({ capability: cap(fm) }))))
    .map(([k]) => k);
  check('[audit] and each of those fixtures really does suppress the reassuring sentence',
    notTripped.length === 0, notTripped);
}
// ---- R1: the deny list that is carrying the silence ------------------------------------------
{
  const c = cap({ tools: ['Read', 'Bash'], disallowedTools: ['Bash'] });
  check('a deny entry that removed an authority tool is reported as load-bearing',
    c.denyLoadBearing.join() === 'Bash', c.denyLoadBearing);
  check('a deny entry that removed a non-authority tool is not load-bearing',
    cap({ tools: ['Read', 'Glob'], disallowedTools: ['Glob'] }).denyLoadBearing.length === 0, true);
  check('a no-op deny entry is not load-bearing',
    cap(REVIEWER).denyLoadBearing.length === 0, cap(REVIEWER).denyLoadBearing);
  const t = flat(CapabilityPanel({ capability: c }));
  check('the quiet panel says the silence rests on the deny list',
    /rests entirely on its/.test(t) && /removes Bash/.test(t), t);
  check("...and does not say so when the deny list is not what made it quiet",
    !/rests entirely on its/.test(flat(CapabilityPanel({ capability: cap({ tools: ['Read'] }) }))), true);
}
// ---- R2: an unreadable tools STRING is not a restriction --------------------------------------
{
  for (const [label, v] of Object.entries({ 'an empty string': '', 'a comma-only string': ', ,' })) {
    const c = cap({ tools: v });
    check(`${label} tools: value is flagged malformed, not read as "none"`, c.malformedTools === true, c);
    check(`${label} rounds toward unrestricted`, c.inherits === true && c.hasBroad === true, c);
  }
  // ...and an EXPLICIT empty list still means what it says. Measured: the CLI granted such an agent
  // zero tools (scripts/fixtures/inherited-tools.json's sibling probe, 2026-09-17), so this is the
  // one branch where "grants: none" is a fact rather than an assumption.
  check('an explicit empty list is still a real restriction, not malformed',
    cap({ tools: [] }).malformedTools === false && cap({ tools: [] }).inherits === false, cap({ tools: [] }));
}
// ---- the inherit case: the file that looks most restricted is the least ----------------------
{
  const c = cap({ mows: { profile: 'default' } }); // no tools: key at all
  check('no tools: key is reported as inheriting, not as an empty tool list', c.inherits === true, c);
  check('an inheriting agent is broad — it has Bash', c.hasBroad === true, c);
  check('an inheriting agent holds every kind of authority',
    kinds(c) === 'shell,subagent,command,write,network', c.authorities);
  check('an inheriting agent does not report a concrete tool list',
    c.narrow === null && c.effective === null, c);
  const panel = CapabilityPanel({ capability: c });
  const t = flat(panel);
  check('the panel says every tool, never "Tools: none", when the key is absent',
    /every tool/.test(t) && !/Tools: none/.test(t), t);
  // M7: round 1 asserted the inherit path on the MODEL only. Suppressing the warning for exactly
  // this shape left the check 66/66 green, which is the coverage hole the reviewer proved.
  check('the panel WARNS for an inheriting agent, not just the model',
    /can run shell commands/.test(t), t);
}
{
  const c = cap({ tools: null });
  check('an empty tools: key inherits too — a blank key is not a restriction', c.inherits === true, c);
}
// F3, the sibling inversion: inheriting AND denying the two beyond-list tools. Round 1 rendered no
// warning at all here while the same panel said "every tool".
{
  const c = cap({ disallowedTools: ['Bash', 'Task'], mows: { profile: 'x' } });
  check('an inheriting agent that denies Bash and Task still holds write and network authority',
    kinds(c) === 'command,write,network', c.authorities);
  const t = flat(CapabilityPanel({ capability: c }));
  check('...and the panel is NOT silent about it', /can write files/.test(t), t);
  check('...and says so about the network too', /can reach the network/.test(t), t);
  check('the deny list is still reflected in the tool sentence', /minus Bash, Task/.test(t), t);
}
{
  const c = cap({ tools: [] }); // an EXPLICIT empty list is a real restriction, unlike the above
  check('an explicit empty list is not inheriting', c.inherits === false, c);
  check('an explicit empty list grants nothing',
    c.hasBroad === false && c.effective.length === 0 && c.authorities.length === 0, c);
  check('the panel says "none" for an explicit empty list',
    /grants: none/.test(flat(CapabilityPanel({ capability: c }))), flat(CapabilityPanel({ capability: c })));
}
{ // Garbage rounds toward unrestricted. Rounding the other way would invent a limit.
  const c = cap({ tools: 42 });
  check('an unparseable tools: field is treated as unrestricted, not as empty',
    c.malformedTools === true && c.inherits === true && c.hasBroad === true, c);
  check('the panel says the granted tools cannot be read',
    /cannot be read/.test(flat(CapabilityPanel({ capability: c }))), flat(CapabilityPanel({ capability: c })));
}
{ // F9: the same rule, applied to the deny list, which round 1 read silently as empty.
  const c = cap({ tools: ['Read', 'Bash'], disallowedTools: 42 });
  check('an unparseable disallowedTools is flagged, not silently read as empty',
    c.malformedDenied === true && c.denied.length === 0, c);
  check('the panel says the deny list could not be read',
    /could not be read/.test(flat(CapabilityPanel({ capability: c }))), flat(CapabilityPanel({ capability: c })));
  check('a well-formed deny list is not flagged malformed', cap(REVIEWER).malformedDenied === false, cap(REVIEWER));
}
{ // F10: a name that differs from a real tool only in case grants nothing and hides a warning.
  const c = cap({ tools: ['Read', 'bash'] });
  check('a miscased tool name is reported', c.miscasedTools.join() === 'bash', c.miscasedTools);
  check('and it confers no authority, because no such tool exists', c.hasBroad === false, c);
  const t = flat(CapabilityPanel({ capability: c }));
  check('the panel says a miscased name hides the warning the real one would raise',
    /differs only in case/.test(t), t);
  check('an ordinary unfamiliar tool name is NOT reported as miscased',
    cap({ tools: ['Read', 'SomeFutureTool'] }).miscasedTools.length === 0, cap({ tools: ['Read', 'SomeFutureTool'] }));
}
check('the comma-separated string form of tools: is understood',
  cap({ tools: 'Read, Bash' }).effective.join() === 'Read,Bash', cap({ tools: 'Read, Bash' }));

// ---- the mirror claim, read out of the validator rather than asserted against a literal -------
// Round 1 compared BROAD_TOOLS to the string 'Bash,Task'. The reviewer widened
// WRITE_CAPABLE_TOOLS in agents/bin/mows-agent-meta and this check stayed green, so the comment
// claiming the two sets are kept identical was guarding nothing. The claim is now (a) weaker and
// true — containment, not equality — and (b) read from the file it is about.
{
  const meta = readFileSync(new URL('agents/bin/mows-agent-meta', ROOT).pathname, 'utf8');
  const m = meta.match(/WRITE_CAPABLE_TOOLS\s*=\s*\{([^}]*)\}/);
  const linterSet = m ? [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map(x => x[1] || x[2]) : null;
  check('[mirror] WRITE_CAPABLE_TOOLS can be read out of mows-agent-meta',
    !!linterSet && linterSet.length > 0, linterSet);
  check('[mirror] every tool the linter calls write-capable is beyond-the-list here too',
    !!linterSet && linterSet.every(t => BROAD_TOOLS.has(t)),
    { linterSet, broad: [...BROAD_TOOLS] });
  check('[mirror] BROAD_TOOLS is exactly the beyondList tools of AUTHORITIES',
    [...BROAD_TOOLS].sort().join() === AUTHORITIES.filter(a => a.beyondList).flatMap(a => a.tools).sort().join(),
    [...BROAD_TOOLS]);
}

// ---- the panel: order, and the sentences that carry the warning ------------------------------
{
  const panel = CapabilityPanel({ capability: cap(REVIEWER) });
  const t = textOf(panel);
  const joined = flat(panel);
  const warnAt = t.findIndex(s => s.includes('can run shell commands'));
  const toolsAt = t.findIndex(s => s.startsWith('Tools its file grants:'));
  check('the shell warning is present for a Bash agent', warnAt !== -1, t);
  check('the tool list is present', toolsAt !== -1, t);
  // The brief's Step 4 acceptance, asserted rather than eyeballed: order is the point. A reader who
  // meets a tidy four-tool list first has already formed the wrong impression.
  check('the shell warning comes BEFORE the tool list, not after',
    warnAt !== -1 && toolsAt !== -1 && warnAt < toolsAt, { warnAt, toolsAt, t });
  check('the warning says the tool list does not bound it',
    /regardless of the tool list/.test(joined), joined);
  check('the panel says the deny list removes nothing', /removes nothing/.test(joined), joined);
  const dom = domText(panel);
  check('the shell warning reads as a sentence, with the space after the bold clause',
    dom.includes('shell commands. It can read'), dom);
  check('the deny-list sentence has its space too',
    /disallowedTools names Write/.test(dom), dom);
  // F1: the one-line summary must not name the directory as a constraint two lines above the line
  // that says it is not one.
  check('the summary line does not name the directory as a constraint',
    /not the tool list, and not the directory/.test(joined) && !/account, directory, budget/.test(joined), joined);
  check('the summary line names the permission rules, which are what actually decide a tool call',
    /permission rules of its profile/.test(joined), joined);
  // F2: the panel states the permissionMode it read, and does not pretend to have checked it.
  check('the panel states the permissionMode it read',
    /permissionMode: default/.test(joined), joined);
  check('the panel says it cannot see the permission rules or a PreToolUse hook',
    /cannot see/.test(joined) && /PreToolUse/.test(joined), joined);
  check('the panel discloses that the CLI, not the file, decides the final tool set',
    /granted a subset of what the file declared/.test(joined), joined);
  // Measured this round: denying one tool removed exactly that tool from an inheriting agent's
  // granted set and nothing else. The inherit path derives authority FROM the deny list, so the
  // panel says on what basis it is entitled to.
  check('the panel says disallowedTools was measured to be honoured, scoped to its evidence',
    /was honoured in every case measured here/.test(joined) && /three tools across both paths/.test(joined), joined);
  check('the workdir is named as a starting directory, not a boundary',
    /not a boundary it is held to/.test(joined), joined);
  check('the profile is not presented as an identity boundary',
    /not an identity boundary/.test(joined), joined);
  check('the daily cap says when it is checked',
    /checked before a run starts/.test(joined), joined);
  check('the chat caveat says the tool list carries across a chat turn',
    /carries this same tool list/.test(joined), joined);
  // That check can only see the SENTENCE. Whether a chat turn actually binds the tool list is a
  // CLI behaviour, measured by hand in scripts/live-agents.sh (a denied Write that must not
  // produce a file, beside a granted Bash that must), which writes the date and CLI version
  // here. A gate that cannot measure something says when it was last measured (spec
  // 2026-09-19 §6.4) — the alternative is a green line about a sentence, read as a fact.
  try {
    const m = readFileSync(new URL('./fixtures/chat-tools-measured.txt', import.meta.url), 'utf8').trim();
    console.log(`NOTE: chat tool enforcement last measured live: ${m}`);
  } catch {
    console.log('NOTE: chat tool enforcement has NEVER been measured live — run scripts/live-agents.sh --yes');
  }
  check('the per-run figures are shown', /\$1\.50/.test(joined) && /\b40\b/.test(joined), joined);
}
// M7 generalised: EVERY fixture that holds authority must warn, and warn above the tool list. A
// single-fixture order assertion is what let the inherit path go unasserted in round 1.
{
  const fixtures = {
    'bash agent': REVIEWER,
    'task-only agent': { tools: ['Read', 'Task'] },
    'write+network agent': { tools: ['Read', 'Write', 'WebFetch'] },
    'inheriting agent': { mows: { profile: 'x' } },
    'inheriting agent denying Bash and Task': { disallowedTools: ['Bash', 'Task'] },
    'slash-command agent': { tools: ['Read', 'SlashCommand'] },
  };
  let worst = null;
  for (const [label, fm] of Object.entries(fixtures)) {
    const c = cap(fm);
    const t = textOf(CapabilityPanel({ capability: c }));
    const warnAt = t.findIndex(s => /^This agent can /.test(s));
    const toolsAt = t.findIndex(s => /^Tools/.test(s));
    if (warnAt === -1 || toolsAt === -1 || warnAt > toolsAt) worst = { label, warnAt, toolsAt, t };
  }
  check('every fixture holding authority warns, above its tool list', worst === null, worst);
}
// The missing-space class, swept across every branch this panel has rather than asserted one
// sentence at a time. Round 1 fixed two instances and shipped a third, which only a browser caught.
{
  const shapes = {
    'bash agent': [cap(REVIEWER), null],
    'bash agent, webhook armed': [cap(REVIEWER, { webhookArmed: true }), null],
    'declared webhook, no secret': [cap({ ...REVIEWER, mows: { ...REVIEWER.mows, triggers: [{ type: 'webhook' }] } }, { webhookArmed: false }), null],
    'task-only agent': [cap({ tools: ['Read', 'Task'] }), null],
    'write+network agent': [cap({ tools: ['Read', 'Write', 'WebFetch'] }), null],
    'narrow agent': [cap({ tools: ['Read'], mows: { profile: 'x' } }), null],
    'inheriting agent': [cap({ mows: { profile: 'x' } }), null],
    'inheriting, denies Bash and Task': [cap({ disallowedTools: ['Bash', 'Task'] }), null],
    'plan-mode agent': [cap({ tools: ['Read', 'Bash'], permissionMode: 'plan' }), null],
    'malformed tools': [cap({ tools: 42 }), null],
    'malformed deny list': [cap({ tools: ['Read'], disallowedTools: 42 }), null],
    'miscased tool': [cap({ tools: ['Read', 'bash'] }), null],
    'explicit empty tool list': [cap({ tools: [] }), null],
    'quiet only because of a load-bearing deny list': [cap({ tools: ['Read', 'Bash', 'Write'], disallowedTools: ['Bash', 'Write'] }), null],
    'mcp plus an unclassified tool': [cap({ tools: ['Read', 'mcp__x__y', 'CronCreate'] }), null],
    'disagreeing turn limits': [cap({ tools: ['Read'], maxTurns: 100, mows: { budget: { usd_per_run: 1, max_turns: 5 } } }), null],
    'unknown capability': [null, null],
  };
  let offenders = null;
  for (const [label, [c]] of Object.entries(shapes)) {
    const bad = joinedWords(CapabilityPanel({ capability: c }));
    if (bad.length) { offenders = { label, bad }; break; }
  }
  check('no branch of the panel runs two words together (the htm newline-trim class)',
    offenders === null, offenders);
}
{ // A quiet panel for a genuinely narrow agent: the warning must not be boilerplate.
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read'], mows: { profile: 'x' } }) }));
  check('no shell warning is shown for an agent that has no shell',
    !/can run shell commands/.test(joined), joined);
  check('no subagent warning either', !/can spawn subagents/.test(joined), joined);
  check('no write or network warning either',
    !/can write files/.test(joined) && !/can reach the network/.test(joined), joined);
  // ...but silence is itself a claim, so the quiet state says what it is and is not.
  check('the quiet panel says what its silence covers',
    /statement about its tool list only/.test(joined), joined);
}
{
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read', 'Task'] }) }));
  check('a Task-only agent gets the subagent warning, not the shell one',
    /can spawn subagents/.test(joined) && !/can run shell commands/.test(joined), joined);
  const taskDom = domText(CapabilityPanel({ capability: cap({ tools: ['Read', 'Task'] }) }));
  check('the subagent warning reads as a sentence too',
    taskDom.includes('spawn subagents. A subagent carries'), taskDom);
}
{ // F2: a `plan` agent would make the authority list wrong, so the panel says so next to it.
  const c = cap({ tools: ['Read', 'Bash'], permissionMode: 'plan' });
  const joined = flat(CapabilityPanel({ capability: c }));
  check('a permissionMode: plan agent gets its warning qualified',
    /meant to stop it\s*acting/.test(joined), joined);
  check('...and a default-mode agent does not get that sentence',
    !/meant to stop it\s*acting/.test(flat(CapabilityPanel({ capability: cap(REVIEWER) }))), true);
}
// ---- unknown, said out loud ------------------------------------------------------------------
{
  const joined = flat(CapabilityPanel({ capability: null }));
  check('a missing capability renders an explicit Unknown, not an empty panel',
    /Unknown/.test(joined) && joined.length > 40, joined);
  check('the unknown panel tells the reader to assume unrestricted',
    /unrestricted/.test(joined), joined);
}
{ // A budget the file does not carry must never render as a hard $0.00 cap.
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read'], mows: { profile: 'x' } }) }));
  check('a missing budget is not rendered as $0.00', !/\$0\.00/.test(joined), joined);
  check('a missing budget says unknown', /an unknown amount/.test(joined), joined);
  check('a missing max_turns says unknown', /an unknown number of/.test(joined), joined);
}
{ // F13: round 1 labelled this "a missing workdir and profile say unknown" and ran it against a
  // fixture whose profile was present, counting /unknown/ hits that the budget strings supplied.
  // Assert the two fields directly instead.
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read'], mows: {} }) }));
  check('a missing profile renders "runs as unknown"', /runs as unknown/.test(joined), joined);
  check('a missing workdir renders "in unknown"', /in unknown/.test(joined), joined);
  check('a missing permissionMode renders "not set"', /permissionMode: not set/.test(joined), joined);
}
// Two turn limits, validated independently by mows-agent-meta and reconciled by nothing.
{
  const agree = cap({ tools: ['Read'], maxTurns: 40, mows: { budget: { usd_per_run: 1, max_turns: 40 } } });
  check('turn limits that agree are not reported as a disagreement',
    agree.policy.turnCapDisagreement === false, agree.policy);
  check('...and the panel says nothing about it',
    !/Claude namespace/.test(flat(CapabilityPanel({ capability: agree }))), flat(CapabilityPanel({ capability: agree })));
  const clash = cap({ tools: ['Read'], maxTurns: 100, mows: { budget: { usd_per_run: 1, max_turns: 5 } } });
  check('two turn limits that disagree are reported', clash.policy.turnCapDisagreement === true, clash.policy);
  check('the Claude-namespace figure is carried so the panel can name it',
    clash.policy.maxTurnsDeclared === 100, clash.policy);
  const t = flat(CapabilityPanel({ capability: clash }));
  check('the panel names both figures and says which one was measured to bind',
    /maxTurns: 100/.test(t) && /5 turns per run/.test(t)
    && /the mows figure is the one that binds/.test(t) && /took four turns/.test(t), t);
  check('a file with only the mows figure is not a disagreement',
    cap({ tools: ['Read'], mows: { budget: { max_turns: 5 } } }).policy.turnCapDisagreement === false, true);
  check('a malformed maxTurns is not reported as a declared figure',
    cap({ tools: ['Read'], maxTurns: 'abc', mows: { budget: { max_turns: 5 } } }).policy.maxTurnsDeclared === null, true);
}
{ // A capability with no daily cap must not invent one.
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read'], mows: { budget: { usd_per_run: 1, max_turns: 2 } } }) }));
  check('no daily-cap sentence when the file declares no daily cap',
    !/per day/.test(joined), joined);
}
// ---- the capability the declared triggers hide, and its mirror -------------------------------
{
  const armed = cap(REVIEWER, { webhookArmed: true });
  check('webhookArmed is carried as a boolean', armed.policy.webhookArmed === true, armed.policy);
  const joined = flat(CapabilityPanel({ capability: armed }));
  check('an armed webhook is disclosed', /can start it/.test(joined), joined);
  check('and it is called out when the file declares no webhook trigger',
    /declares no webhook trigger/.test(joined), joined);
  const both = flat(CapabilityPanel({ capability: cap({ ...REVIEWER,
    mows: { ...REVIEWER.mows, triggers: [{ type: 'webhook' }] } }, { webhookArmed: true }) }));
  check('a DECLARED webhook trigger is not called out as undeclared',
    /can start it/.test(both) && !/declares no webhook trigger/.test(both), both);
  const quiet = flat(CapabilityPanel({ capability: cap(REVIEWER, { webhookArmed: false }) }));
  check('no webhook sentence when no secret is configured', !/can start it/.test(quiet), quiet);
  check('webhookArmed defaults to null, not false — undetermined is not "no"',
    cap(REVIEWER).policy.webhookArmed === null, cap(REVIEWER).policy);
  // F11: round 1 disclosed armed-but-undeclared and said nothing about declared-but-inert.
  const inert = cap({ ...REVIEWER, mows: { ...REVIEWER.mows, triggers: [{ type: 'webhook' }] } }, { webhookArmed: false });
  check('a declared webhook with no secret is reported inert',
    inert.policy.webhookDeclaredInert === true, inert.policy);
  check('and the panel says its webhook URL answers 404',
    /answers 404/.test(flat(CapabilityPanel({ capability: inert }))), flat(CapabilityPanel({ capability: inert })));
  check('inertness is not inferred when the secret was never looked up',
    cap({ ...REVIEWER, mows: { ...REVIEWER.mows, triggers: [{ type: 'webhook' }] } }).policy.webhookDeclaredInert === false, true);
}
// ---- hostile text out of an agent file --------------------------------------------------------
// The panel renders strings a .md file controls. This branch has already shipped one stored XSS
// through agent-controlled text (views/chat.mjs), so the property is asserted, not assumed.
{
  const PAYLOAD = '<img src=x onerror="alert(1)">';
  // Every string below originates in the agent .md file. The prop assertion checks the whole set,
  // not just the one that looks most like an exploit: a workdir smuggled into a title attribute is
  // the realistic mistake, and a detector that only knew the word "onerror" would wave it through.
  const c = cap({
    tools: [PAYLOAD, 'Bash'], disallowedTools: ['<script>alert(2)</script>'],
    permissionMode: '<marquee>plan</marquee>',
    mows: { profile: PAYLOAD, workdir: 'javascript:alert(3)',
      budget: { usd_per_run: 1, max_turns: 1 },
      triggers: [{ type: PAYLOAD }, 'not-even-an-object', null] },
  });
  const tree = CapabilityPanel({ capability: c });
  const tags = tagsOf(tree), props = propsOf(tree), text = textOf(tree);
  check('no dangerouslySetInnerHTML anywhere in the panel',
    !props.some(([k]) => k === 'dangerouslySetInnerHTML'), props.map(([k]) => k));
  // Every tag is one this file wrote. A payload that became an element would show up here.
  check('every element in the tree is a static tag this file wrote',
    tags.every(t => ['div', 'h2', 'p', 'b', 'ul', 'li', 'code', 'span'].includes(t)), tags);
  const AGENT_TEXT = [PAYLOAD, '<script>alert(2)</script>', 'javascript:alert(3)', '<marquee>plan</marquee>'];
  check('no prop value carries agent-controlled text',
    !props.some(([, v]) => typeof v === 'string' && AGENT_TEXT.some(a => v.includes(a))), props);
  // Four separate places take agent-controlled text: the tool list, the profile, permissionMode and
  // the trigger types. Every one must land in a text node with the payload intact.
  check('every agent-controlled field is rendered as TEXT, verbatim',
    text.filter(s => s.includes(PAYLOAD)).length >= 3, text);
  check('the permissionMode string is rendered as text too',
    text.some(s => s.includes('<marquee>plan</marquee>')), text);
  // Inert must not mean invisible — the same rule chat-view-check.mjs applies to a defused reply.
  check('the javascript: workdir is still shown to the operator',
    text.some(s => s.includes('javascript:alert(3)')), text);
  // A trigger entry need not be an object; a string and a null are both legal YAML here. A well
  // formed entry keeps its declared type verbatim (hostile or not) — only the shapes that have no
  // readable type become 'unknown'.
  check('a malformed trigger entry reads as unknown, not as undefined',
    c.policy.triggerTypes.join('|') === PAYLOAD + '|unknown|unknown', c.policy.triggerTypes);
  // A hostile permissionMode must not be able to trip the `plan` branch by looking like it.
  check('a permissionMode that merely contains "plan" does not trip the plan qualifier',
    !/meant to stop it\s*acting/.test(flat(tree)), flat(tree));
}

// ---- the measured numbers the panel prints, pinned -------------------------------------------
// The panel tells an operator "an inheriting agent was granted 27 tools, of which this page
// classifies 8". Round 2 put that in prose with nothing behind it, the probe agents were deleted,
// and the re-review could not adjudicate it (R4a) — a measured claim with no gate, which is the
// exact shape check 5e exists to close, reintroduced one round later. The measurement now lives in
// scripts/fixtures/inherited-tools.json (with its CLI version and date) and the arithmetic is
// recomputed here from the shipped model's own sets, so the numbers in the copy cannot drift from
// the evidence without this going red.
{
  let fx = null, err = null;
  try { fx = JSON.parse(readFileSync(new URL('scripts/fixtures/inherited-tools.json', ROOT).pathname, 'utf8')); }
  catch (e) { err = String(e.message || e); }
  check('[pinned] the measured inherited tool set is in the tree', !!fx?.granted_tools?.length, err);
  const granted = fx?.granted_tools || [];
  const AUTH = AUTHORITIES.flatMap(a => a.tools);
  // BENIGN_TOOLS is not exported (it is an implementation detail of the residue rule), so the
  // classification is recomputed the only way a consumer can: a tool is classified iff the model
  // reports it as neither unclassified nor mcp.
  const c = agentCapability({ tools: granted });
  const unclassified = (c.unclassifiedTools || []).length + (c.mcpTools || []).length;
  check('[pinned] the inherited set is the size the panel claims', granted.length === 27, granted.length);
  check('[pinned] the panel classifies exactly the number it prints',
    granted.length - unclassified === 8, { granted: granted.length, unclassified });
  check('[pinned] and AUTHORITIES itself matches 7 of them, not 8 — the comment now says so',
    granted.filter(t => AUTH.includes(t)).length === 7, granted.filter(t => AUTH.includes(t)));
  check('[pinned] the fixture records what it was measured against',
    !!fx?.cli_version && !!fx?.measured_at, fx && { cli: fx.cli_version, at: fx.measured_at });
  const panelText = flat(CapabilityPanel({ capability: agentCapability({ mows: {} }) }));
  check('[pinned] the panel prints the numbers this fixture supports',
    panelText.includes(`granted ${granted.length} tools`)
    && panelText.includes(`classifies ${granted.length - unclassified}`), panelText);
}

// ---- one parser, not two ---------------------------------------------------------------------
// The model is fed by mows-agent-meta, the validator the CLI itself runs. This section proves the
// two agree about a REAL agent file in this repo, so a change to either that broke the contract
// between them cannot pass by agreeing with itself. It FAILS rather than skips when python3 or
// PyYAML is missing (ci.yml installs python3-yaml for exactly this reason).
{
  const meta = new URL('agents/bin/mows-agent-meta', ROOT).pathname;
  const file = new URL('agents/examples/harness-reviewer.md', ROOT).pathname;
  let fm = null, err = null;
  try { fm = JSON.parse(execFileSync('python3', [meta, 'json', file], { encoding: 'utf8' })); }
  catch (e) { err = String(e.message || e).split('\n')[0]; }
  check('[integration] mows-agent-meta parses the example agent file', fm !== null, err);
  // Deliberately NOT nested in `if (fm)`: an assertion that silently does not run is invisible to
  // scripts/capability-coverage.mjs, which can only reason about lines that were printed. A
  // conditional block would make a dead parser look like three assertions nothing could break.
  const c = fm ? agentCapability(fm, { webhookArmed: false }) : null;
  check('[integration] the shipped example yields the effective list, not the deny list',
    !!c && c.effective.join() === 'Read,Glob,Grep,Bash' && !c.effective.includes('Write'), c && c.effective);
  check('[integration] the shipped example is flagged broad', !!c && c.hasBroad === true, c);
  check('[integration] its policy reaches the panel',
    !!c && /mows-harness/.test(flat(CapabilityPanel({ capability: c }))), c && c.policy);
}

// ---- what the fuzz pass found, pinned by name (Task 9) ---------------------------------------
// Both of these were live against the module as it stood, both are one ordinary YAML keystroke
// away, and neither was catchable by the method that produced the 153 assertions above: every
// hand-written fixture spells its tool names correctly and picks one syntax.
{
  const asStr = agentCapability({ tools: 'Read, Bash' }, {});
  const asArr = agentCapability({ tools: ['Read', 'Bash '] }, {});
  check('the same declaration reads the same as a comma string and as a list',
    asStr.hasBroad === asArr.hasBroad && asArr.effective.join() === asStr.effective.join(),
    { asStr: asStr.effective, asArr: asArr.effective });
  check('a padded tool name in a LIST still names its authority',
    agentCapability({ tools: [' Bash '] }, {}).broad.join() === 'Bash',
    agentCapability({ tools: [' Bash '] }, {}));
  // `- Bash:` instead of `- Bash` parses as {Bash: null}. It used to stringify to "[object
  // Object]", and the panel then gave a confident tool list, with no shell authority named, for an
  // agent file it had not read.
  const typo = agentCapability({ tools: ['Read', { Bash: null }] }, {});
  check('a list with a non-string entry is unreadable, and rounds toward unrestricted',
    typo.malformedTools === true && typo.inherits === true && typo.effective === null, typo);
  check('a list that names something and yet yields no tool is unreadable too',
    agentCapability({ tools: [''] }, {}).malformedTools === true,
    agentCapability({ tools: [''] }, {}));
  // ...while the one list shape that IS a restriction stays one. The two must not be conflated:
  // the CLI was measured granting an agent with `tools: []` zero tools.
  const emptyList = agentCapability({ tools: [] }, {});
  check('an explicit empty list is still a real restriction, not unreadable',
    emptyList.inherits === false && emptyList.malformedTools === false && emptyList.effective.length === 0, emptyList);
  // The deny list gets the same parse, and the direction that matters there is the opposite one:
  // a padded deny entry must still SUBTRACT, or the panel understates nothing and overstates the
  // restriction instead.
  const denyPad = agentCapability({ tools: ['Read', 'Bash'], disallowedTools: ['Bash '] }, {});
  check('a padded entry in the DENY list still subtracts',
    denyPad.hasBroad === false && denyPad.denyLoadBearing.join() === 'Bash', denyPad);
}

// ---- a random-input pass over the model (Task 9) ---------------------------------------------
//
// Same reasoning as the fuzz section in scripts/chat-view-check.mjs: every fixture above is one a
// person thought of, and the two findings pinned immediately above are what that misses. The
// oracles here are PROPERTIES rather than expected outputs — an expected-output test over random
// frontmatter would just be a second implementation of the module.
//
// Deterministic: a fixed seed list, because scripts/capability-coverage.mjs re-executes this file
// once per mutation and two runs have to be comparable.
{
  const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const BEYOND = AUTHORITIES.filter(a => a.beyondList).flatMap(a => a.tools);
  const NAMES = [...AUTHORITIES.flatMap(a => a.tools), 'Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead',
    'BashOutput', 'ExitPlanMode', 'bash', 'BASH', 'write', 'task', 'mcp__figma__x', 'CronCreate',
    'SendMessage', 'Workflow', 'EnterWorktree', '', ' ', 'Bash ', ' Bash', 'Réad', '__proto__', 'constructor'];
  const pickFrom = (r, a) => a[Math.floor(r() * a.length)];
  const toolsValue = r => {
    const k = r();
    const list = () => { const n = Math.floor(r() * 6), o = []; for (let i = 0; i < n; i++) o.push(pickFrom(r, NAMES)); return o; };
    if (k < 0.30) return list();
    if (k < 0.50) return list().join(',');
    if (k < 0.56) return list().join(', ');
    if (k < 0.62) return undefined;
    if (k < 0.66) return null;
    if (k < 0.70) return '';
    if (k < 0.74) return ', ,';
    if (k < 0.78) return 42;
    if (k < 0.82) return true;
    if (k < 0.86) return { a: 1 };
    if (k < 0.90) return [];
    if (k < 0.94) return [null, 3, { Bash: null }];
    return pickFrom(r, NAMES);
  };
  const genFm = r => {
    const o = {};
    const t = toolsValue(r); if (t !== undefined) o.tools = t;
    if (r() < 0.75) o.disallowedTools = toolsValue(r);
    if (r() < 0.4) o.permissionMode = pickFrom(r, ['default', 'plan', 'acceptEdits', 'bypassPermissions', 7, null, {}]);
    if (r() < 0.4) o.maxTurns = pickFrom(r, [1, 5, 100, 0, -3, 2.5, '5', null]);
    if (r() < 0.6) {
      const m = {};
      if (r() < 0.7) m.profile = pickFrom(r, ['work', 42, null]);
      if (r() < 0.7) m.workdir = pickFrom(r, ['/srv/x', '', 0, null]);
      if (r() < 0.7) m.budget = pickFrom(r, [{ usd_per_run: 1.5, max_turns: 5 }, { max_turns: '5' }, 'nope', null, {}]);
      if (r() < 0.7) m.triggers = pickFrom(r, [[{ type: 'cron' }], [{ type: 'webhook' }], ['cron'], [null], 'cron', 3, [{}]]);
      o.mows = pickFrom(r, [m, m, m, 'not-an-object', 7, [m], null]);
    }
    return o;
  };
  // The module's own parse, restated so the oracles below do not disagree with it for reasons of
  // their own. It is the ONE thing here that is a copy, and it is a copy on purpose: an oracle
  // that imports the parse it is checking cannot catch the parse being wrong.
  const parse = v => Array.isArray(v)
    ? (v.every(x => typeof x === 'string') ? v.map(s => s.trim()).filter(Boolean) : null)
    : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : null;

  const SEEDS = [1, 2, 3, 5, 7], PER = 700;
  let broadSeen = 0, unreadableConfident = null, syntaxFlip = null, hiddenAuthority = null, denyAdded = null, threw = null;
  for (const sd of SEEDS) {
    const r = rng(sd);
    for (let i = 0; i < PER; i++) {
      const f = genFm(r);
      // EVERYTHING in this block is guarded, not just the call to the model. The chat and agent
      // views have no error boundary, so a throw ANYWHERE on this path — in agentCapability or in
      // a consumer reading the object it returned — blanks the page rather than one panel. The
      // oracles below are such a consumer, so when one of them throws that IS the finding and it is
      // recorded here instead of taking this whole file down with it.
      //
      // Not hypothetical: mutation C3 leaves `inherits` false while `effective` stays null, and the
      // deny-list oracle's `c.effective.every(...)` threw on exactly that. Before this guard the
      // check died at assertion 159 of 165 and the coverage sweep reported the run INCOMPLETE.
      try {
      const c = agentCapability(f, { webhookArmed: r() < 0.5 });
      if (c.hasBroad) broadSeen++;

      // (a) a CONFIDENT answer may only be given about a value the module could actually read
      const readableArray = !Array.isArray(f.tools) || f.tools.every(x => typeof x === 'string');
      if (!c.inherits && !c.malformedTools && !readableArray) unreadableConfident = unreadableConfident || { seed: sd, i, fm: f, c };

      if (Array.isArray(f.tools) && readableArray && f.tools.length) {
        // (b) SYNTAX must not change the verdict: padding names, or writing the list as a comma
        // string, are the same declaration to anyone reading the file. The comma form is skipped
        // when a name itself contains a comma — that is one bogus tool in a list and two real ones
        // in a string, and the module is right about both.
        const padded = agentCapability({ ...f, tools: f.tools.map(t => ' ' + t + ' ') }, {});
        if (padded.hasBroad !== c.hasBroad) syntaxFlip = syntaxFlip || { seed: sd, i, fm: f, was: c.broad, now: padded.broad };
        if (!f.tools.some(t => t.includes(','))) {
          const joined = agentCapability({ ...f, tools: f.tools.join(',') }, {});
          if (joined.hasBroad !== c.hasBroad) syntaxFlip = syntaxFlip || { seed: sd, i, fm: f, was: c.broad, now: joined.broad };
        }
        // (c) METAMORPHIC: granting a beyond-the-list tool must always be NAMED. A parse that
        // silently loses a tool is the entire bug class this module exists for.
        const denied = parse(f.disallowedTools) || [];
        for (const b of BEYOND) {
          if (denied.includes(b)) continue;
          const plus = agentCapability({ ...f, tools: [...f.tools, b] }, {});
          if (!plus.hasBroad || !plus.broad.includes(b)) { hiddenAuthority = hiddenAuthority || { seed: sd, i, tool: b, fm: f, plus }; break; }
        }
      }
      // (d) the deny list may only ever SUBTRACT, never add
      if (!c.inherits) {
        const open = agentCapability({ ...f, disallowedTools: [] }, {});
        if (!open.inherits && !c.effective.every(t => open.effective.includes(t))) denyAdded = denyAdded || { seed: sd, i, fm: f, c, open };
      }
      } catch (e) { threw = threw || { seed: sd, i, fm: f, e: String(e && e.message || e) }; }
    }
  }
  const total = SEEDS.length * PER;
  console.log(`  fuzz: ${total} generated frontmatters over seeds ${SEEDS.join(',')}; ${broadSeen} of them hold beyond-the-list authority`);
  // The corpus has to reach the branch the oracles are about, or "0 findings" means nothing.
  check('[fuzz] the corpus reaches the beyond-the-list branch at all',
    broadSeen > total / 10, broadSeen);
  check('[fuzz] nothing on this path throws: not the model, not a consumer reading its result',
    threw === null, threw);
  check('[fuzz] no generated frontmatter gets a confident answer about a tools value it could not read',
    unreadableConfident === null, unreadableConfident);
  check('[fuzz] the syntax a readable tool list is written in never changes the verdict',
    syntaxFlip === null, syntaxFlip);
  check('[fuzz] a beyond-the-list tool added to a readable allow list is always named',
    hiddenAuthority === null, hiddenAuthority);
  check('[fuzz] the deny list only ever subtracts', denyAdded === null, denyAdded);
}

// ---- the validator and this panel must read `tools:` the same way (Task 9 fix round 1) --------
//
// agents/bin/mows-agent-meta decides whether an agent file is ACCEPTED; this module decides what
// the dashboard SAYS about it. They are separate programs in separate languages and neither can
// import the other, so "they agree" has to be asserted rather than commented — a validator and a
// panel disagreeing about what a field means is exactly how the panel ends up describing a file
// the runner reads differently.
//
// They disagreed twice until Task 9's fuzzing: only the string branch stripped, so
// `tools: ["Bash "]` read as a shell tool in one and an unknown name in the other; and a list
// carrying a non-string was coerced (`v.map(String)` / bare `list(v)`), which made one invent
// "[object Object]" as a tool name and the other raise TypeError on `set(tools)`.
//
// THE ONE DIFFERENCE THAT REMAINS, and it is allowed on purpose rather than papered over: a value
// that parses to ZERO names (`tools: ''`, `tools: ', ,'`, `tools: ['']`). This panel calls that
// unreadable and rounds toward unrestricted, because "" is not a restriction anyone wrote on
// purpose; the validator calls it the empty list. Neither reads a TOOL out of it, which is the
// property that matters here, so the rule below permits exactly that and nothing wider. Whether
// the validator should reject such a file outright is a separate question and nobody has measured
// what the CLI does with it.
{
  const metaPath = new URL('agents/bin/mows-agent-meta', ROOT).pathname;
  // Every shape either program can be handed, including the two that used to split them.
  const TABLE = [
    'Read, Bash', ' Read , Bash ', 'Bash', '', ', ,',
    ['Read', 'Bash'], ['Read', 'Bash '], [' Read ', ' Bash '], [], [''], ['  '],
    ['Read', { Bash: null }], ['Read', ['Bash']], [null], [3], [true],
    42, true, { a: 1 }, null, undefined,
  ];
  // sys.dont_write_bytecode: importing a file with no .py extension still drops a __pycache__ into
  // agents/bin, which preflight's junk-file gate rejects (it caught exactly that during Task 9).
  const PY = `
import importlib.util, importlib.machinery, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_loader('m', importlib.machinery.SourceFileLoader('m', sys.argv[1]))
m = importlib.util.module_from_spec(spec)
sys.argv = [sys.argv[0]]
try:
    spec.loader.exec_module(m)
except SystemExit:
    pass
print(json.dumps([m.as_list(v) for v in json.loads(sys.stdin.read())]))
`;
  let py = null, pyErr = null;
  try {
    py = JSON.parse(execFileSync('python3', ['-c', PY, metaPath],
      { encoding: 'utf8', input: JSON.stringify(TABLE) }));
  } catch (e) { pyErr = String(e.message || e).split('\n').slice(0, 3).join(' | '); }
  // Not nested in `if (py)`: an assertion that silently does not run is invisible to the coverage
  // sweep, which can only reason about lines that were printed.
  check('[agreement] the validator\'s own as_list is callable from here', py !== null, pyErr);

  // THREE STATES, not two. Round 1 collapsed "unreadable" and "inherits everything" into one null
  // and let a single carve-out cover both, which absorbed the `tools: null` row without naming it
  // (review F4) — and that row is not a gap, it is a DISAGREEMENT: the panel reads *no restriction
  // at all* and the validator reads *the empty list*, which are opposite meanings.
  const jsParse = v => {
    const c = agentCapability({ tools: v }, {});
    if (c.malformedTools) return { kind: 'unreadable' };
    if (c.inherits) return { kind: 'inherits' };
    return { kind: 'list', names: c.effective };
  };
  const rows = TABLE.map((v, i) => ({ v, js: jsParse(v), py: py ? py[i] : undefined }));
  const missing = rows.filter(r => r.py === undefined);

  // (1) the agreement proper.
  const differ = rows.filter(r => r.js.kind === 'list' && !missing.includes(r)
    && JSON.stringify(r.js.names) !== JSON.stringify(r.py));
  check('[agreement] where the panel reads a tools: list, the validator reads exactly the same names',
    differ.length === 0 && missing.length === 0, { differ: differ.slice(0, 4), missing: missing.length });

  // (2) THE CARVE-OUT, now bounded to what it was always described as: a value that names ZERO
  // tools. `tools: ''`, `', ,'`, `['']`, `['  ']`. The panel calls these unreadable and rounds
  // toward unrestricted; the validator calls them the empty list. Neither reads a TOOL out of
  // them, which is the property that matters, and nobody has measured what the CLI does with an
  // empty string — so this is a documented gap and not a licence to differ anywhere else.
  const leaks = rows.filter(r => r.js.kind === 'unreadable' && !missing.includes(r)
    && !(r.py === null || r.py.length === 0));
  check('[agreement] where the panel refuses a tools: value, the validator reads no tool out of it',
    leaks.length === 0 && missing.length === 0, leaks.slice(0, 4));

  // (3) THE ONE REAL DIVERGENCE, asserted by name rather than absorbed. `tools: null` and an absent
  // key mean "inherits every tool the main thread has, Bash included". `as_list` returns [] for
  // both. That collapse is what made the validator call an inheriting agent read-only and go quiet
  // about a webhook trigger on it — fixed in mows-agent-meta's can_write, which now models
  // inheritance explicitly, and gated in scripts/e2e-agents.sh through BOTH consumers of that flag.
  // What remains here is the parse-level difference, which is real and is written down.
  const inh = rows.filter(r => r.js.kind === 'inherits');
  check('[agreement] tools: null is where the two parses MEAN different things, and it is named here',
    inh.length > 0 && inh.every(r => Array.isArray(r.py) && r.py.length === 0), inh);

  // ...and the table has to reach all three states, or the rules above are true of nothing.
  const n = k => rows.filter(r => r.js.kind === k).length;
  console.log(`  agreement: ${rows.length} tools: shapes — ${n('list')} read as a list, ${n('unreadable')} refused, ${n('inherits')} read as inheritance`);
  check('[agreement] the table exercises all three states, not just the easy one',
    n('list') > 3 && n('unreadable') > 3 && n('inherits') > 0, { list: n('list'), unreadable: n('unreadable'), inherits: n('inherits') });
}

process.exit(failed ? 1 : 0);
