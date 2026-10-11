// The capability panel: what this agent can actually DO, above the box where you talk to it. A lazy chunk of its own (agent.mjs
// imports it on mount); ported from the /ui app's views/capability.mjs with the same wording and the same rules.
//
// TWO RULES GOVERN THIS FILE.
//
// 1. Nothing here may claim a restriction that is not enforced, AND nothing may stay quiet about authority the agent holds.
//    Silence on a page titled "What this agent can do" reads as "this one is fine", so it is a claim like any other. Each kind
//    of authority is named, and each policy line says what that field is actually worth — `workdir` is a `cd`, `profile` picks
//    a Claude account and not an OS user, and a deny list is powerless against an agent that has Bash. Where the server could
//    not determine something it sends null and this panel says unknown.
//
// 2. Every interpolated value reaches the DOM as a preact TEXT CHILD. No dangerouslySetInnerHTML, no markdown, no HTML string
//    built from data — scripts/capability-check.mjs walks the rendered tree to keep it that way. This panel renders strings
//    straight out of a .md file (a workdir, a cron spec, tool names); text nodes make the whole class of injection unreachable.
//
// A NOTE ON WRAPPING. The htm version trimmed a static chunk that began or ended with a newline, so a sentence wrapped next to
// an element lost its space ("shell commands.It can read"). Written with h(), every text child here is one string and the space
// is part of it, written as ' ' where a child ends and an element follows; capability-check.mjs asserts the DOM concatenation.
//
// `usd()` is used for real numbers only. It coerces anything else to $0.00, and "$0.00 per run" is a lie in the most dangerous
// direction — it reads as a hard zero-cost cap where there is in fact no readable cap at all.
import { h } from 'preact';
import { usd } from '../ui.mjs';

const money = n => (typeof n === 'number' && Number.isFinite(n)) ? usd(n) : 'an unknown amount';
const count = n => (typeof n === 'number' && Number.isFinite(n)) ? String(n) : 'an unknown number of';

// One sentence per kind of authority. The shell sentence keeps the brief's wording verbatim.
const AUTHORITY_TEXT = {
  shell: ['This agent can run shell commands.',
    'It can read and write any file this account can reach, regardless of the tool list below.'],
  subagent: ['This agent can spawn subagents.',
    'A subagent carries its own tool list, which this agent’s deny list does not reach, so it can reach any file this account can reach.'],
  command: ['This agent can run project slash commands.',
    'A command’s own frontmatter can carry allowed-tools: Bash, so it can reach a shell the list below does not name.'],
  write: ['This agent can write files.',
    'Nothing confines those writes to its working directory: this box’s own configuration and other agents’ definitions are reachable.'],
  network: ['This agent can reach the network.',
    'It can send anything it has read off this box, and fetch instructions from outside it.'],
};

const b = (...k) => h('b', null, ...k);
const code = (...k) => h('code', null, ...k);

export function CapabilityPanel({ capability: c }) {
  // Unknown is a state this panel must be able to occupy out loud. A run record outlives its agent file (retention_days keeps the
  // record; the file can be deleted, moved to another profile, or broken), and rendering nothing at all would leave the operator
  // reading the Chat box below with no idea what is on the other end.
  if (!c) {
    return h('div', { class: 'cap' },
      h('h2', null, 'What this agent can do'),
      h('p', { class: 'cap-warn' }, b('Unknown.'),
        ' Its agent file could not be read, was not found in any profile, or did not parse — so this page cannot say what tools, account, directory or budget it runs with. Assume it is unrestricted until you have read the file yourself.'));
  }
  const p = c.policy || {}, bd = p.budget || {};
  const types = p.triggerTypes || [];
  const auth = c.authorities || [];
  const planned = p.permissionMode === 'plan';
  // EVERY array field is read with `?.`, without exception: a payload missing one of them throws and takes the whole agent page
  // down, and the rule is uniform because a rule with exceptions is not a rule anyone can follow.
  //
  // The quiet state, computed rather than assumed. It is this panel's most reassuring output, so every path that reaches it is a
  // place a permissive agent could hide (a missing `tools:` key, a deny list on the inherit path, a fully-populated list of
  // writing and network tools, an `mcp__*` tool). `quiet` is the single condition under which the reassuring sentence may appear.
  const quiet = !auth.length && !c.inherits && !c.malformedTools && !c.malformedDenied
    && !c.miscasedTools?.length && !c.mcpTools?.length && !c.unclassifiedTools?.length;
  return h('div', { class: 'cap' },
    h('h2', null, 'What this agent can do'),
    !!auth.length && h('div', { class: 'cap-warn' },
      h('ul', { class: 'auth' },
        auth.map(a => h('li', { key: a.kind }, b(AUTHORITY_TEXT[a.kind][0]), ' ', AUTHORITY_TEXT[a.kind][1], ' ', h('span', { class: 'muted' }, '(', a.tools.join(', '), ')')))),
      planned && h('p', null, 'Its file sets ', code('permissionMode: plan'),
        ', which is meant to stop it acting on any of the above. This page cannot verify that the CLI honours it.')),
    !!c.mcpTools?.length && h('p', { class: 'cap-unknown' }, b('Its reach through MCP is unknown.'), ' ',
      'It holds ', c.mcpTools.join(', '),
      '. What an MCP tool can do — reach the network, the filesystem, a production database — depends entirely on the server behind it, and none of that is knowable from the tool name. This page will not guess in either direction.'),
    !!c.unclassifiedTools?.length && h('p', { class: 'cap-unknown' }, b('This page cannot classify ', c.unclassifiedTools.join(', '), '.'), ' ',
      'Its list of known tools is fixed and the CLI\'s is not, so treat the reach of these as unknown rather than as harmless.'),
    c.inherits && h('p', { class: 'cap-warn' },
      'Inheriting also brings every tool this page has no name for. On this box an inheriting agent was granted 27 tools, of which this page classifies 8 — the rest included tools that create cron jobs, trigger other agents and send messages.'),
    quiet && h('p', { class: 'muted' },
      'No tool it holds confers shell access, subagents, file writes or network reach, and this page recognises all of them.',
      c.denyLoadBearing?.length
        ? [' That rests entirely on its ', code('disallowedTools'), ', which removes', ' ', c.denyLoadBearing.join(', '),
          ' from the list its file grants — measured on this box, a deny list is honoured, but the quiet above is the deny list\'s doing and not the tool list\'s.']
        : '',
      ' That is a statement about its tool list only — read the rest of this panel before treating it as harmless.'),
    c.inherits
      ? h('p', { class: 'muted' }, 'Tools: ', b('every tool'), ' — its file lists no ', code('tools:'),
        ', and a Claude Code agent without one inherits all of them',
        c.denied?.length ? [', minus ', c.denied.join(', ')] : '', '.')
      // `c.effective ? …` rather than `c.effective.join(…)`: the model only ever sends null here together with inherits:true, but a
      // panel that THROWS on an inconsistent payload takes the whole agent page down, and "unknown" is both the safe render and the
      // honest one. A coverage mutation that decoupled the two flags found this by crashing the check.
      : h('p', { class: 'muted' }, 'Tools its file grants: ', c.effective ? (c.effective.join(', ') || 'none') : 'unknown'),
    c.malformedTools && h('p', { class: 'cap-warn' }, 'Its ', code('tools:'),
      ' field is not a list, so what it is actually granted cannot be read here. Shown above as unrestricted, which is the safe way to be wrong; ',
      code('mows-agent-meta lint'), ' rejects the file outright.'),
    c.malformedDenied && h('p', { class: 'cap-warn' }, 'Its ', code('disallowedTools'),
      ' field is not a list and could not be read, so nothing above accounts for it. Treated as empty, which over-states what this agent holds rather than under-stating it.'),
    !!c.miscasedTools?.length && h('p', { class: 'cap-warn' }, 'Its tool list names ', c.miscasedTools.join(', '),
      ', which differs only in case from a real tool. Tool names are validated by nothing, so a name like that grants no tool AND hides the warning the real one would have raised.'),
    !!c.denyNoop?.length && h('p', { class: 'muted' }, 'Its ', code('disallowedTools'), ' ', 'names ', c.denyNoop.join(', '),
      ', which removes nothing: the tool list above never granted them.'),
    h('p', { class: 'muted' }, 'What constrains it is its account, its budget, its triggers and the permission rules of its profile — not the tool list, and not the directory.'),
    h('ul', { class: 'policy' },
      h('li', null, 'runs as ', b(p.profile || 'unknown'),
        ' — a Claude profile, which selects an account and its subscription. Every agent on this box runs under the same OS login and can reach the same files, so this is not an identity boundary.'),
      h('li', null, 'in ', b(p.workdir || 'unknown'), ' — the directory it starts in, not a boundary it is held to.'),
      h('li', null, 'under ', b('permissionMode: ', p.permissionMode || 'not set'),
        ', as written in its file. This page reports what it read; it cannot check what the CLI does with it.'),
      // measured live: scripts/live-agents.sh — a chat turn with --agent reports the denied tool absent and never produces the file,
      // in every session measured on 2026-09-19; the dated result is in scripts/fixtures/chat-tools-measured.txt and
      // capability-check.mjs prints it. What that run could NOT settle is what the permission regime does with a GRANTED Bash: the
      // auto classifier refused the same in-workdir read in one session and allowed it in the next.
      h('li', null, 'up to ', b(money(bd.usd_per_run)), ' and ', b(count(bd.max_turns)), ' turns per run',
        bd.usd_per_day != null
          ? [', and ', money(bd.usd_per_day), ' per day — the daily cap is checked before a run starts, so it does not stop a run already under way']
          : '',
        '. A chat turn below is capped separately by mows-agent and is not covered by the per-run figure; it carries this same tool list (measured, not assumed).',
        p.turnCapDisagreement
          ? [' Its file also sets ', b('maxTurns: ', p.maxTurnsDeclared),
            ' in the Claude namespace, which contradicts the figure above. Measured on this box, the mows figure is the one that binds: a run with ',
            code('maxTurns: 2'), ' and', ' ', code('--max-turns 20'), ' ', 'took four turns. Nothing in the toolchain cross-checks the two.']
          : ''),
      h('li', null, `${types.length} trigger(s) declared${types.length ? `: ${types.join(', ')}` : ''}`)),
    p.webhookArmed && h('p', { class: 'cap-warn' },
      'A webhook secret is configured for it, so an HTTP POST carrying a valid signature can start it',
      types.includes('webhook') ? '' : ' — even though its file declares no webhook trigger', '.'),
    p.webhookDeclaredInert && h('p', { class: 'muted' }, 'Its declared webhook trigger is inert: no secret is configured for it, so its webhook URL answers 404.'),
    h('p', { class: 'muted' }, 'What this page cannot see: the profile\'s permission rules, any ', code('PreToolUse'),
      ' hook (', code('agents/SETUP.md'), ' makes a write-deny hook a precondition for a shell-capable agent), and any MCP server ', code('mows-agent'),
      ' passes in. Each can remove authority listed above. The CLI also decides the final tool set, and in every run measured on this box it granted a subset of what the file declared — ',
      code('Glob'), ' ', 'and ', code('Grep'),
      ' reached only the one agent that named them without ', code('Bash'),
      '. A file\'s ', code('disallowedTools'),
      ' was honoured in every case measured here: three tools across both paths, each removing exactly itself and nothing else.'));
}

// The comp's amber line, one per authority kind, keyed off `authorities` — ordered strongest-first by capability.mjs, so the first
// entry IS the headline. Not a re-wording of the panel's prose: same source field, shorter sentence, and the panel says the rest.
const AUTHORITY_LINE = {
  shell: 'Shell execution granted.',
  subagent: 'Can dispatch subagents with their own tools.',
  command: 'Can run slash commands.',
  write: 'Can write files.',
  network: 'Can reach the network.',
};
export function CapSummary({ capability: c }) {
  // null capability and an inheriting agent are DIFFERENT unknowns and neither may render as a tidy chip row: one means the file
  // was unreadable, the other that the list is not a bound at all. Both defer to the panel rather than inventing a summary.
  if (!c) return h('p', { class: 'muted' }, 'Its agent file could not be read.');
  const head = c.authorities?.[0];
  return h('div', null,
    c.inherits
      ? h('p', { class: 'capsum-in' }, 'Inherits every tool — its file lists none.')
      : h('div', { class: 'cchips' }, (c.effective || []).map(t => h('span', { class: 'cchip', key: t }, t))),
    head && h('p', { class: 'capsum-warn' }, AUTHORITY_LINE[head.kind] || `Holds ${head.kind} authority.`));
}
