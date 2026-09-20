import { useState, useEffect } from 'preact/hooks';
import { html, Pill, usd, rel } from '../ui.mjs';
import { getJSON, connect, subscribe } from '../store.mjs';
import { Chat } from './chat.mjs';
import { CapabilityPanel } from './capability.mjs';

export function AgentsList() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    connect(['agents']);
    getJSON('/api/agents').then(d => setRows(d.agents)).catch(() => setRows([]));
    // The server sends a FULL SNAPSHOT each tick, so the snapshot decides membership: mapping
    // over `cur` instead could only ever patch rows already present — a new agent never
    // appeared and a removed one never went away. Merge each snapshot row over any existing
    // row to keep fields the snapshot does not carry.
    return subscribe('agents', live => setRows(cur => {
      const prev = new Map((cur || []).map(r => [r.name, r]));
      return live.map(l => ({ ...prev.get(l.name), ...l }));
    }));
  }, []);
  if (!rows) return html`<p class="muted">Loading…</p>`;
  if (!rows.length) return html`<p class="muted">No agents yet.</p>`;
  return html`<div>
    <h1>agents</h1>
    ${rows.map(a => html`<a class="agent card" href="/ui/agents/${a.name}" key=${a.name}>
      <b>${a.name}</b> <${Pill} state=${a.state} />
      <span class="muted">${a.last_event_at ? rel(Date.parse(a.last_event_at)) : 'never ran'} · ${a.total} runs · 7d ${usd(a.cost7d)}</span>
    </a>`)}
  </div>`;
}

// A telemetry row renders NOTHING when its value is absent, rather than an em-dash placeholder.
// capability is null whenever the agent file could not be read or parsed (see capability.mjs),
// and a card of confident "—"s is exactly the misreading that module exists to prevent: an
// absent row says "not stated", a dash says "stated as nothing".
const Row = ({ k, v }) => v == null || v === '' ? null
  : html`<div class="trow"><span class="tk">${k}</span><span class="tv">${v}</span></div>`;

// A run id is YYYYMMDD-HHMMSS-PID. The comp renders it "17:32-2473" — short enough for a 320px
// column, and the form used here. But that shape is only unambiguous WITHIN A DAY: two runs at
// 17:32 a week apart print identically, and this list holds the last twenty runs, not the last
// day's. So the date comes back as soon as it is doing work — today's runs read exactly as the
// comp, older ones carry "09-16" in front. The full id stays in the title either way.
// Anything that does not match the pattern is returned untouched rather than sliced blindly.
const RUN_ID = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)\d\d-(\d{1,4})/;
function runLabel(id, now = new Date()) {
  const m = RUN_ID.exec(id);
  if (!m) return id;
  const [, y, mo, d, hh, mm, pid] = m;
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `${y + mo + d === today ? '' : `${mo}-${d} `}${hh}:${mm}-${pid}`;
}

function Telemetry({ policy }) {
  if (!policy) return html`<p class="muted">Its agent file could not be read, so nothing here is known.</p>`;
  const b = policy.budget || {};
  // Budget and Daily Cap are each built from two fields that can independently be missing, so
  // they are assembled rather than templated: a literal `$${x} / ${y} turns` prints "$undefined"
  // the moment one half is absent, which is the flattering-when-wrong failure this file avoids.
  const budget = [b.usd_per_run != null && `$${(+b.usd_per_run).toFixed(2)}`,
                  b.max_turns != null && `${b.max_turns} turns`].filter(Boolean).join(' / ');
  const daily = b.usd_per_day != null ? `$${(+b.usd_per_day).toFixed(2)} per day` : null;
  return html`<div class="tgrid">
    <${Row} k="Profile" v=${policy.profile} />
    <${Row} k="Target" v=${policy.workdir} />
    <${Row} k="Trigger" v=${policy.triggerTypes?.join(', ')} />
    <${Row} k="Budget" v=${budget} />
    <${Row} k="Daily Cap" v=${daily} />
  </div>`;
}

// The comp's amber line, one per authority kind, keyed off `authorities` — which is ordered
// strongest-first by capability.mjs, so the first entry IS the headline. Not a re-wording of the
// panel's prose: same source field, shorter sentence, and the panel below says the rest.
const AUTHORITY_LINE = {
  shell: 'Shell execution granted.',
  subagent: 'Can dispatch subagents with their own tools.',
  command: 'Can run slash commands.',
  write: 'Can write files.',
  network: 'Can reach the network.',
};
function CapSummary({ capability: c }) {
  // null capability and an inheriting agent are DIFFERENT unknowns and neither may render as a
  // tidy chip row: one means the file was unreadable, the other that the list is not a bound at
  // all. Both defer to the panel rather than inventing a summary of something unknown.
  if (!c) return html`<p class="muted">Its agent file could not be read.</p>`;
  const head = c.authorities?.[0];
  return html`<div>
    ${c.inherits
      ? html`<p class="capsum-in">Inherits every tool — its file lists none.</p>`
      : html`<div class="cchips">${(c.effective || []).map(t => html`<span class="cchip" key=${t}>${t}</span>`)}</div>`}
    ${head && html`<p class="capsum-warn">${AUTHORITY_LINE[head.kind] || `Holds ${head.kind} authority.`}</p>`}
  </div>`;
}

export function AgentDetail({ name }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); getJSON(`/api/agents/${name}`).then(setD).catch(() => setD(false)); }, [name]);
  if (d === false) return html`<p class="muted">No such agent.</p>`;
  if (!d) return html`<p class="muted">Loading…</p>`;
  const live = d.recs?.[0]?.state === 'working';
  const model = d.capability?.policy?.model;
  return html`<div class="agwrap">
    <a class="agback" href="/ui/agents">← agents</a>
    <div class="ag2">
      <section class="agchat">
        <header class="agh">
          ${/* Phone-only back control, in the header where iOS puts one. The desktop comp has a
                separate "← agents" line above the card (.agback); on a phone that line was a
                ghosted 12px string alone in a 100px dead zone under the notch. One of the two is
                shown per breakpoint, by CSS. */ ''}
          <a class="agback-in" href="/ui/agents" aria-label="Back to agents">←</a>
          <span class="agav" aria-hidden="true"></span>
          <div class="agti">
            <h1>${name}${live && html` <span class="agdot" title="running"></span>`}</h1>
            <p class="agsub">${[model, `${usd(d.cost7d)} spent`].filter(Boolean).join(' · ')}</p>
          </div>
          <form class="agctl" method="post" action="/a/agent-run">
            <input type="hidden" name="name" value=${name} />
            <input type="hidden" name="back" value=${`/ui/agents/${name}`} />
            <button class="cbtn" title="Run now" aria-label="Run now"></button>
          </form>
        </header>
        ${/* The comp's hint line names four tools. It is passed ONLY when the agent file gave a
              genuine explicit list: `effective` is null whenever the agent inherits, and printing
              a short confident list for the file that is actually least restricted is the exact
              inversion capability.mjs exists to prevent. Inheriting agents get no hint line —
              the Capabilities card beside it already says what they can reach, at length. */ ''}
        <${Chat} name=${name} events=${d.events}
          tools=${d.capability?.effective?.length ? d.capability.effective.join(', ') : null} />
      </section>
      <aside class="agside">
        <div class="card"><h2 class="cl">Agent Telemetry</h2>
          <${Telemetry} policy=${d.capability?.policy} /></div>
        ${/* The comp's Capabilities card is chips plus one amber line. Ours is the full honest
              panel, which runs ~1000px and pushed Recent Runs off the fold entirely. The answer
              is NOT to trim the panel: it is the safety surface, and shortening it to fit a
              mockup is precisely the trade this whole module refuses. So the comp's summary is
              surfaced — chips and the strongest authority, both computed from the SAME
              structured fields the panel renders, never re-worded prose — and the full report
              sits one disclosure below it, losing nothing. */ ''}
        <div class="card"><h2 class="cl">Capabilities</h2>
          <${CapSummary} capability=${d.capability} />
          <details class="capmore"><summary>Full capability report</summary>
            <${CapabilityPanel} capability=${d.capability} /></details></div>
        <div class="card"><h2 class="cl">Recent Runs</h2>
          ${(d.recs || []).length
            ? html`<ul class="rruns">${d.recs.map(r => html`<li key=${r.run_id}>
                <${Pill} state=${r.state} />
                <a href="/ui/agents/${name}/${r.run_id}" title=${r.run_id}>${runLabel(r.run_id)}</a>
                <span class="rcost">${usd(r.cost_usd)}</span></li>`)}</ul>`
            : html`<p class="muted">Never run.</p>`}</div>
        ${/* The agent's working memory (spec 2026-09-19), read-only. null and '' are different
              states and both are shown as words: null means mows-agent has never stored one,
              '' means the agent emitted an empty block — cleared it on purpose. A <pre> of the
              text otherwise; the file is Markdown but rendering it would invite the same
              injection surface the chat view had to close, for a card whose whole job is
              "show what it wrote". */ ''}
        <div class="card"><h2 class="cl">Memory</h2>
          ${d.memory == null ? html`<p class="muted">No memory yet.</p>`
            : d.memory === '' ? html`<p class="muted">Cleared by the agent.</p>`
            : html`<pre class="mem">${d.memory}</pre>`}</div>
        ${/* The comp has no events surface, but this view had one and dropping it would lose
              the only place the raw unit log is readable. Collapsed rather than deleted: shut,
              it costs the design one hairline; open, nothing regressed. */ ''}
        <details class="card agev"><summary>Events</summary>
          <pre class="events">${(d.events || []).join('\n') || 'none'}</pre></details>
      </aside>
    </div>
  </div>`;
}
