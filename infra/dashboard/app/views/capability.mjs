import { html, usd } from '../ui.mjs';

// The capability panel: what this agent can actually DO, above the box where you talk to it.
//
// TWO RULES GOVERN THIS FILE.
//
// 1. Nothing here may claim a restriction that is not enforced. Every value comes from the agent
//    file, and most of those fields are documentation rather than a fence: `workdir` is a `cd`,
//    `profile` picks a Claude account and not an OS user, and a deny list is powerless against an
//    agent that has Bash. So each line that names a policy field also says what that field is
//    worth. A tidy list with no caveats would read as a sandbox description and none of it is a
//    sandbox. Where the server could not determine something it sends null, and this panel says
//    unknown rather than filling the gap in.
//
// 2. Every interpolated value reaches the DOM as a preact TEXT CHILD. There is no
//    dangerouslySetInnerHTML here, no markdown, no HTML string built from data — deliberately, and
//    scripts/capability-check.mjs walks the rendered tree to keep it that way. This panel renders
//    strings straight out of a .md file (a workdir, a cron spec, tool names), and this branch has
//    already shipped one stored XSS through exactly that kind of text
//    (infra/dashboard/app/views/chat.mjs). Text nodes make the whole class unreachable; the guarded
//    markdown renderer in chat.mjs is the only other sanctioned path, and a policy field has no
//    business being markdown.
//
// `usd()` is used for real numbers only. It coerces anything else to $0.00, and "$0.00 per run" is
// a lie in the most dangerous direction — it reads as a hard zero-cost cap where there is in fact
// no readable cap at all.
const money = n => (typeof n === 'number' && Number.isFinite(n)) ? usd(n) : 'an unknown amount';
const count = n => (typeof n === 'number' && Number.isFinite(n)) ? String(n) : 'an unknown number of';

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
  return html`<div class="cap">
    <h2>What this agent can do</h2>
    ${c.hasBroad && (c.broad.includes('Bash')
      // The leading space after </b> is load-bearing and must stay on the SAME SOURCE LINE as the
      // text it precedes: htm trims a static chunk that begins with a newline, so wrapping right
      // after the </b> renders "shell commands.It can read" with no space. Seen in a browser, not
      // reasoned about; scripts/capability-check.mjs now asserts the concatenation directly.
      ? html`<p class="cap-warn"><b>This agent can run shell commands.</b>${' '}It can read and
          write any file this account can reach, regardless of the tool list below.</p>`
      // Task without Bash is the same authority one level down: a subagent gets its own tool list,
      // which the parent's disallowedTools never reaches. Saying "can run shell commands" would be
      // wrong; saying nothing would be worse.
      // Same ${' '} as above, and for the same reason — this branch had the defect too, and only a
      // DOM-concatenation assertion could see it (the flat-text one reads both as correct).
      : html`<p class="cap-warn"><b>This agent can spawn subagents.</b>${' '}A subagent carries its
          own tool list, which this agent's deny list does not reach, so it can reach any file this
          account can reach regardless of the tool list below.</p>`)}
    ${c.inherits
      ? html`<p class="muted">Tools: <b>every tool</b> — its file lists no <code>tools:</code>,
          and a Claude Code agent without one inherits all of them${c.denied.length
            ? html`, minus ${c.denied.join(', ')}` : ''}.</p>`
      : html`<p class="muted">Tools: ${c.effective.join(', ') || 'none'}</p>`}
    ${c.malformedTools && html`<p class="cap-warn">Its <code>tools:</code> field is not a list, so
      what it is actually granted cannot be read here. Shown above as unrestricted, which is the
      safe way to be wrong; <code>mows-agent-meta lint</code> rejects the file outright.</p>`}
    ${!!c.denyNoop.length && html`<p class="muted">Its <code>disallowedTools</code>${' '}names ${c.denyNoop.join(', ')},
      which removes nothing: the tool list above never granted them.</p>`}
    <p class="muted">What actually constrains it is its account, directory, budget and triggers —
      not the tool list.</p>
    <ul class="policy">
      <li>runs as <b>${p.profile || 'unknown'}</b> — a Claude profile, which selects an account and
        its subscription. Every agent on this box runs under the same OS login and can reach the
        same files, so this is not an identity boundary.</li>
      <li>in <b>${p.workdir || 'unknown'}</b> — the directory it starts in, not a boundary it is
        held to.</li>
      <li>up to <b>${money(b.usd_per_run)}</b> and <b>${count(b.max_turns)}</b> turns per run${
        b.usd_per_day != null
          ? html`, and ${money(b.usd_per_day)} per day — the daily cap is checked before a run
              starts, so it does not stop a run already under way`
          : ''}. Chat turns below are capped separately by mows-agent and are not covered by the
        per-run figure.</li>
      <li>${types.length} trigger(s) declared${types.length ? `: ${types.join(', ')}` : ''}</li>
    </ul>
    ${p.webhookArmed && html`<p class="cap-warn">A webhook secret is configured for it, so an HTTP
      POST carrying a valid signature can start it${types.includes('webhook') ? ''
        : ' — even though its file declares no webhook trigger'}.</p>`}
  </div>`;
}
