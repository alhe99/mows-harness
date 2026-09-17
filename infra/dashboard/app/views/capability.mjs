import { html, usd } from '../ui.mjs';

// The capability panel: what this agent can actually DO, above the box where you talk to it.
//
// TWO RULES GOVERN THIS FILE.
//
// 1. Nothing here may claim a restriction that is not enforced, AND nothing may stay quiet about
//    authority the agent holds. Round 1 got the first half and missed the second: an agent with
//    Write, Edit and WebFetch rendered a completely silent panel. Silence on a page titled "What
//    this agent can do" reads as "this one is fine", so it is a claim like any other. Each kind of
//    authority is now named, and each policy line says what that field is actually worth —
//    `workdir` is a `cd`, `profile` picks a Claude account and not an OS user, and a deny list is
//    powerless against an agent that has Bash. Where the server could not determine something it
//    sends null and this panel says unknown.
//
// 2. Every interpolated value reaches the DOM as a preact TEXT CHILD. No dangerouslySetInnerHTML,
//    no markdown, no HTML string built from data — and scripts/capability-check.mjs walks the
//    rendered tree to keep it that way. This panel renders strings straight out of a .md file (a
//    workdir, a cron spec, tool names), and this branch has already shipped one stored XSS through
//    exactly that kind of text (views/chat.mjs). Text nodes make the whole class unreachable.
//
// A NOTE ON WRAPPING. htm trims a static chunk that begins with a newline, so a sentence wrapped
// immediately after a closing tag or an interpolation loses its space ("shell commands.It can
// read"). Where that would happen the space is written as ${' '} on the same source line. Three
// instances shipped broken in round 1; capability-check.mjs now asserts the DOM concatenation.
//
// `usd()` is used for real numbers only. It coerces anything else to $0.00, and "$0.00 per run" is
// a lie in the most dangerous direction — it reads as a hard zero-cost cap where there is in fact
// no readable cap at all.
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

export function CapabilityPanel({ capability: c }) {
  // Unknown is a state this panel must be able to occupy out loud. A run record outlives its agent
  // file (retention_days keeps the record; the file can be deleted, moved to another profile, or
  // broken), and rendering nothing at all would leave the operator reading the Chat box below with
  // no idea what is on the other end.
  if (!c) {
    return html`<div class="cap">
      <h2>What this agent can do</h2>
      <p class="cap-warn"><b>Unknown.</b> Its agent file could not be read, was not found in any
        profile, or did not parse — so this page cannot say what tools, account, directory or
        budget it runs with. Assume it is unrestricted until you have read the file yourself.</p>
    </div>`;
  }
  const p = c.policy || {}, b = p.budget || {};
  const types = p.triggerTypes || [];
  const auth = c.authorities || [];
  const planned = p.permissionMode === 'plan';
  // EVERY array field is read with `?.`, without exception. Not defensiveness for its own sake: a
  // payload missing one of them throws and takes the whole agent page down, and round 2 shipped a
  // version where the two newest fields were guarded and the two older ones were not — so the next
  // field added would have copied whichever neighbour it landed beside. The rule is uniform because
  // a rule with exceptions is not a rule anyone can follow (re-review R5).
  //
  // The quiet state, computed rather than assumed. It is this panel's most reassuring output, so
  // every path that reaches it is a place a permissive agent could hide — four were found that way
  // (a missing `tools:` key, a deny list on the inherit path, a fully-populated list of writing and
  // network tools, and an `mcp__*` tool). `quiet` is now the single condition under which the
  // reassuring sentence is allowed to appear, so a future path that reaches it has to come through
  // here and be named, instead of silently inheriting the sentence.
  const quiet = !auth.length && !c.inherits && !c.malformedTools && !c.malformedDenied
    && !c.miscasedTools?.length && !c.mcpTools?.length && !c.unclassifiedTools?.length;
  return html`<div class="cap">
    <h2>What this agent can do</h2>
    ${!!auth.length && html`<div class="cap-warn">
      <ul class="auth">
        ${auth.map(a => html`<li key=${a.kind}><b>${AUTHORITY_TEXT[a.kind][0]}</b>${' '}${AUTHORITY_TEXT[a.kind][1]}${' '}<span class="muted">(${a.tools.join(', ')})</span></li>`)}
      </ul>
      ${planned && html`<p>Its file sets <code>permissionMode: plan</code>, which is meant to stop it
        acting on any of the above. This page cannot verify that the CLI honours it.</p>`}
    </div>`}
    ${!!c.mcpTools?.length && html`<p class="cap-unknown"><b>Its reach through MCP is unknown.</b>${' '}It
      holds ${c.mcpTools.join(', ')}. What an MCP tool can do — reach the network, the filesystem, a
      production database — depends entirely on the server behind it, and none of that is knowable
      from the tool name. This page will not guess in either direction.</p>`}
    ${!!c.unclassifiedTools?.length && html`<p class="cap-unknown"><b>This page cannot classify ${c.unclassifiedTools.join(', ')}.</b>${' '}Its
      list of known tools is fixed and the CLI's is
      not, so treat the reach of these as unknown rather than as harmless.</p>`}
    ${c.inherits && html`<p class="cap-warn">Inheriting also brings every tool this page has no name
      for. On this box an inheriting agent was granted 27 tools, of which this page classifies 8 —
      the rest included tools that create cron jobs, trigger other agents and send messages.</p>`}
    ${quiet && html`<p class="muted">No tool it holds confers shell access, subagents, file
      writes or network reach, and this page recognises all of them.${c.denyLoadBearing?.length
        ? html` That rests entirely on its <code>disallowedTools</code>, which removes${' '}
            ${c.denyLoadBearing.join(', ')} from the list its file grants — measured on this box,
            a deny list is honoured, but the quiet above is the deny list's doing and not the tool
            list's.` : ''} That is a statement about its
      tool list only — read the rest of this panel before treating it as harmless.</p>`}
    ${c.inherits
      ? html`<p class="muted">Tools: <b>every tool</b> — its file lists no <code>tools:</code>,
          and a Claude Code agent without one inherits all of them${c.denied?.length
            ? html`, minus ${c.denied.join(', ')}` : ''}.</p>`
      // `c.effective ? …` rather than `c.effective.join(…)`: the model only ever sends null here
      // together with inherits:true, but a panel that THROWS on an inconsistent payload takes the
      // whole agent page down, and "unknown" is both the safe render and the honest one. A
      // coverage mutation that decoupled the two flags found this by crashing the check.
      : html`<p class="muted">Tools its file grants: ${c.effective ? (c.effective.join(', ') || 'none') : 'unknown'}</p>`}
    ${c.malformedTools && html`<p class="cap-warn">Its <code>tools:</code> field is not a list, so
      what it is actually granted cannot be read here. Shown above as unrestricted, which is the
      safe way to be wrong; <code>mows-agent-meta lint</code> rejects the file outright.</p>`}
    ${c.malformedDenied && html`<p class="cap-warn">Its <code>disallowedTools</code> field is not a
      list and could not be read, so nothing above accounts for it. Treated as empty, which
      over-states what this agent holds rather than under-stating it.</p>`}
    ${!!c.miscasedTools?.length && html`<p class="cap-warn">Its tool list names ${c.miscasedTools.join(', ')},
      which differs only in case from a real tool. Tool names are
      validated by nothing, so a name like that grants no tool AND hides the warning the real one
      would have raised.</p>`}
    ${!!c.denyNoop?.length && html`<p class="muted">Its <code>disallowedTools</code>${' '}names ${c.denyNoop.join(', ')},
      which removes nothing: the tool list above never granted them.</p>`}
    <p class="muted">What constrains it is its account, its budget, its triggers and the permission
      rules of its profile — not the tool list, and not the directory.</p>
    <ul class="policy">
      <li>runs as <b>${p.profile || 'unknown'}</b> — a Claude profile, which selects an account and
        its subscription. Every agent on this box runs under the same OS login and can reach the
        same files, so this is not an identity boundary.</li>
      <li>in <b>${p.workdir || 'unknown'}</b> — the directory it starts in, not a boundary it is
        held to.</li>
      <li>under <b>permissionMode: ${p.permissionMode || 'not set'}</b>, as written in its file.
        This page reports what it read; it cannot check what the CLI does with it.</li>
      <li>up to <b>${money(b.usd_per_run)}</b> and <b>${count(b.max_turns)}</b> turns per run${
        b.usd_per_day != null
          ? html`, and ${money(b.usd_per_day)} per day — the daily cap is checked before a run
              starts, so it does not stop a run already under way`
          : ''}. A chat turn below is capped separately by mows-agent and is not covered by the
        per-run figure; it carries this same tool list (measured, not assumed).${p.turnCapDisagreement
          ? html` Its file also sets <b>maxTurns: ${p.maxTurnsDeclared}</b> in the Claude namespace,
              which contradicts the figure above. Measured on this box, the mows figure is the one
              that binds: a run with <code>maxTurns: 2</code> and${' '}<code>--max-turns 20</code>${' '}
              took four turns. Nothing in the toolchain cross-checks the two.` : ''}</li>
      <li>${types.length} trigger(s) declared${types.length ? `: ${types.join(', ')}` : ''}</li>
    </ul>
    ${p.webhookArmed && html`<p class="cap-warn">A webhook secret is configured for it, so an HTTP
      POST carrying a valid signature can start it${types.includes('webhook') ? ''
        : ' — even though its file declares no webhook trigger'}.</p>`}
    ${p.webhookDeclaredInert && html`<p class="muted">Its declared webhook trigger is inert: no
      secret is configured for it, so its webhook URL answers 404.</p>`}
    <p class="muted">What this page cannot see: the profile's permission rules, any${' '}
      <code>PreToolUse</code> hook (<code>agents/SETUP.md</code> makes a write-deny hook a
      precondition for a shell-capable agent), and any MCP server <code>mows-agent</code> passes in.
      Each can remove authority listed above. The CLI also decides the final tool set, and in every
      run measured on this box it granted a subset of what the file declared — <code>Glob</code>${' '}
      and <code>Grep</code> reached only the one agent that named them without <code>Bash</code>.
      A file's <code>disallowedTools</code> was honoured in every case measured here: three tools
      across both paths, each removing exactly itself and nothing else.</p>
  </div>`;
}
