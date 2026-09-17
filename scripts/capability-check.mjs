// Persisted regression check for Task 8's capability panel — the claim that the panel states
// EFFECTIVE capability and never a restriction that nothing enforces.
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
// Requires Node >= 22.15 (node:module.registerHooks) and, for the last section only, python3 with
// PyYAML. Both FAIL rather than skip: a gate that quietly excuses itself reports green.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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

const { agentCapability, BROAD_TOOLS } = await import(new URL('infra/dashboard/capability.mjs', ROOT).href);
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
// "shell commands.It can read" as correct, and a browser showed it in the first screenshot taken
// of this panel. htm trims a static chunk that starts with a newline, which makes this the default
// failure mode of wrapping a sentence right after an interpolation or a closing tag.
const domText = node => textOf(node).join('').replace(/\s+/g, ' ');
function tagsOf(node) { const out = []; walk(node, v => { if (v.tag) out.push(v.tag); }); return out; }
function propsOf(node) { // [[name, value]] for every non-children prop in the tree
  const out = [];
  walk(node, v => { if (v.props) for (const [k, val] of Object.entries(v.props)) out.push([k, val]); });
  return out;
}
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
  mows: { profile: 'default', workdir: '~/Documents/Projects/mows-harness',
    budget: { usd_per_run: 1.5, max_turns: 40, usd_per_day: 6, quota_floor: 30 },
    triggers: [{ type: 'cron', spec: '*-*-* 06:00:00' }] },
};

// ---- the model: effective capability, never the declared one ---------------------------------
{
  const c = cap(REVIEWER);
  check('a denied tool that was never granted is absent from effective',
    !c.effective.includes('Write'), c.effective);
  check('effective is the allow list, not the deny list',
    c.effective.join() === 'Read,Glob,Grep,Bash', c.effective);
  check('Bash in the tool list makes hasBroad true despite the deny list', c.hasBroad === true, c);
  check('the deny list is reported as the no-op it is',
    c.denyNoop.join() === 'Write,Edit,WebFetch,NotebookEdit', c.denyNoop);
  // Optional chaining is not defensiveness for its own sake: scripts/capability-coverage.mjs
  // mutates the budget away, and an assertion that THROWS instead of failing takes every
  // assertion after it down with it — the mutation then buys no coverage at all and the sweep
  // cannot tell that from a mutation nothing noticed.
  check('policy carries the mows block through', c.policy.workdir === REVIEWER.mows.workdir
    && c.policy.profile === 'default' && c.policy.budget?.usd_per_run === 1.5, c.policy);
  check('trigger types are flattened for the view', c.policy.triggerTypes.join() === 'cron', c.policy.triggerTypes);
}
{ // A genuinely narrow agent: no Bash, no Task. This is the case the panel must NOT over-warn on,
  // and the only shape for which a quiet panel is the honest one.
  const c = cap({ tools: ['Read', 'Grep'], mows: { profile: 'default' } });
  check('an agent with neither Bash nor Task is not flagged broad', c.hasBroad === false, c);
  check('its narrow tools are listed', c.narrow.join() === 'Read,Grep', c.narrow);
}
{ // Deny lists that actually bite.
  const c = cap({ tools: ['Read', 'Bash'], disallowedTools: ['Bash'] });
  check('a denied tool that WAS granted is subtracted', c.effective.join() === 'Read', c.effective);
  check('denying the only broad tool clears hasBroad', c.hasBroad === false, c);
  check('a deny entry that actually bit is not reported as a no-op', c.denyNoop.length === 0, c.denyNoop);
}
{ // Task without Bash: the same authority one level down, and it must still be flagged.
  const c = cap({ tools: ['Read', 'Task'] });
  check('Task alone counts as broad', c.hasBroad === true && c.broad.join() === 'Task', c);
}
// ---- the inherit case: the file that looks most restricted is the least ----------------------
{
  const c = cap({ mows: { profile: 'default' } }); // no tools: key at all
  check('no tools: key is reported as inheriting, not as an empty tool list', c.inherits === true, c);
  check('an inheriting agent is broad — it has Bash', c.hasBroad === true, c);
  check('an inheriting agent does not claim a narrow tool list',
    c.narrow.length === 0 && c.effective.length === 0, c);
  const t = flat(CapabilityPanel({ capability: c }));
  check('the panel says every tool, never "Tools: none", when the key is absent',
    /every tool/.test(t) && !/Tools: none/.test(t), t);
}
{
  const c = cap({ tools: null });
  check('an empty tools: key inherits too — a blank key is not a restriction', c.inherits === true, c);
}
{
  const c = cap({ tools: [] }); // an EXPLICIT empty list is a real restriction, unlike the above
  check('an explicit empty list is not inheriting', c.inherits === false, c);
  check('an explicit empty list grants nothing', c.hasBroad === false && c.effective.length === 0, c);
  check('the panel says "none" for an explicit empty list',
    /Tools: none/.test(flat(CapabilityPanel({ capability: c }))), flat(CapabilityPanel({ capability: c })));
}
{ // Garbage rounds toward unrestricted. Rounding the other way would invent a limit.
  const c = cap({ tools: 42 });
  check('an unparseable tools: field is treated as unrestricted, not as empty',
    c.malformedTools === true && c.inherits === true && c.hasBroad === true, c);
  check('the panel says the granted tools cannot be read',
    /cannot be read/.test(flat(CapabilityPanel({ capability: c }))), flat(CapabilityPanel({ capability: c })));
}
check('the comma-separated string form of tools: is understood',
  cap({ tools: 'Read, Bash' }).effective.join() === 'Read,Bash', cap({ tools: 'Read, Bash' }));
check('BROAD_TOOLS matches mows-agent-meta WRITE_CAPABLE_TOOLS',
  [...BROAD_TOOLS].sort().join() === 'Bash,Task', [...BROAD_TOOLS]);

// ---- the panel: order, and the sentences that carry the warning ------------------------------
{
  const panel = CapabilityPanel({ capability: cap(REVIEWER) });
  const t = textOf(panel);
  // flat(), not t.join(' '): the source wraps these sentences across lines, so the text nodes carry
  // the indentation with them. Asserting on un-collapsed text would be asserting on where this
  // file happens to wrap, which no reader ever sees.
  const joined = flat(panel);
  const warnAt = t.findIndex(s => s.includes('can run shell commands'));
  const toolsAt = t.findIndex(s => s.startsWith('Tools:'));
  check('the shell warning is present for a Bash agent', warnAt !== -1, t);
  check('the tool list is present', toolsAt !== -1, t);
  // The brief's Step 4 acceptance, asserted rather than eyeballed: order is the point. A reader
  // who meets a tidy four-tool list first has already formed the wrong impression.
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
  check('the workdir is named as a starting directory, not a boundary',
    /not a boundary it is held to/.test(joined), joined);
  check('the profile is not presented as an identity boundary',
    /not an identity boundary/.test(joined), joined);
  check('the daily cap says when it is checked',
    /checked before a run starts/.test(joined), joined);
  check('the per-run figures are shown', /\$1\.50/.test(joined) && /\b40\b/.test(joined), joined);
}
{ // A quiet panel for a genuinely narrow agent: the warning must not be boilerplate.
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read'], mows: { profile: 'x' } }) }));
  check('no shell warning is shown for an agent that has no shell',
    !/can run shell commands/.test(joined), joined);
  check('no subagent warning either', !/can spawn subagents/.test(joined), joined);
}
{
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read', 'Task'] }) }));
  check('a Task-only agent gets the subagent warning, not the shell one',
    /can spawn subagents/.test(joined) && !/can run shell commands/.test(joined), joined);
  // The same missing-space defect lived in this branch too. Asserted on the DOM concatenation,
  // because `joined` (space-joined) reads "subagents. A subagent" either way.
  const taskDom = domText(CapabilityPanel({ capability: cap({ tools: ['Read', 'Task'] }) }));
  check('the subagent warning reads as a sentence too',
    taskDom.includes('spawn subagents. A subagent carries'), taskDom);
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
  check('a missing workdir and profile say unknown',
    (joined.match(/unknown/g) || []).length >= 3, joined);
}
{ // A capability with no daily cap must not invent one.
  const joined = flat(CapabilityPanel({ capability: cap({ tools: ['Read'], mows: { budget: { usd_per_run: 1, max_turns: 2 } } }) }));
  check('no daily-cap sentence when the file declares no daily cap',
    !/per day/.test(joined), joined);
}
// ---- the capability the declared triggers hide -----------------------------------------------
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
    tags.every(t => ['div', 'h2', 'p', 'b', 'ul', 'li', 'code'].includes(t)), tags);
  const AGENT_TEXT = [PAYLOAD, '<script>alert(2)</script>', 'javascript:alert(3)'];
  check('no prop value carries agent-controlled text',
    !props.some(([, v]) => typeof v === 'string' && AGENT_TEXT.some(a => v.includes(a))), props);
  check('the hostile tool name is rendered as TEXT, verbatim',
    text.some(s => s.includes(PAYLOAD)), text);
  // Three separate places take agent-controlled text: the tool list, the profile, the trigger
  // types. Every one of them must land in a text node with the payload intact.
  check('every agent-controlled field is rendered as TEXT, verbatim',
    text.filter(s => s.includes(PAYLOAD)).length >= 3, text);
  // Inert must not mean invisible — the same rule chat-view-check.mjs applies to a defused reply.
  check('the javascript: workdir is still shown to the operator',
    text.some(s => s.includes('javascript:alert(3)')), text);
  // A trigger entry need not be an object. Reaching into .type on a string or a null would print
  // "undefined" as if it were a trigger type.
  // A trigger entry need not be an object; a string and a null are both legal YAML here. A well
  // formed entry keeps its declared type verbatim (hostile or not) — only the shapes that have no
  // readable type become 'unknown'.
  check('a malformed trigger entry reads as unknown, not as undefined',
    c.policy.triggerTypes.join('|') === PAYLOAD + '|unknown|unknown', c.policy.triggerTypes);
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

process.exit(failed ? 1 : 0);
