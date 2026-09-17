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

export function AgentDetail({ name }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); getJSON(`/api/agents/${name}`).then(setD).catch(() => setD(false)); }, [name]);
  if (d === false) return html`<p class="muted">No such agent.</p>`;
  if (!d) return html`<p class="muted">Loading…</p>`;
  return html`<div>
    <h1><a href="/ui/agents">← agents</a> <span class="muted">· ${name}</span></h1>
    <p><${Pill} state=${d.recs?.[0]?.state} /> <span class="muted">7d ${usd(d.cost7d)} · ${d.total} runs · Next: ${d.timer?.label || '—'}</span></p>
    <${CapabilityPanel} capability=${d.capability} />
    <h2>Chat</h2><${Chat} name=${name} runs=${d.recs} />
    <h2>Runs</h2>
    <ul class="runs">${(d.recs || []).map(r => html`<li key=${r.run_id}>
      <a href="/ui/agents/${name}/${r.run_id}">${r.run_id}</a> <${Pill} state=${r.state} />
      <span class="muted">${usd(r.cost_usd)} · ${r.turns} turns · ${r.tool_calls} tools</span></li>`)}</ul>
    <h2>Events</h2><pre class="events">${(d.events || []).join('\n') || 'none'}</pre>
  </div>`;
}
