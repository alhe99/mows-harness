import { useState, useEffect } from 'preact/hooks';
import { html, Pill, usd, rel } from '../ui.mjs';
import { getJSON, connect, subscribe } from '../store.mjs';
import { Chat } from './chat.mjs';

export function AgentsList() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    connect(['agents']);
    getJSON('/api/agents').then(d => setRows(d.agents)).catch(() => setRows([]));
    return subscribe('agents', live => setRows(cur => (cur || []).map(r => ({ ...r, ...(live.find(l => l.name === r.name) || {}) }))));
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
    <h2>Chat</h2><${Chat} name=${name} runs=${d.recs} />
    <h2>Runs</h2>
    <ul class="runs">${(d.recs || []).map(r => html`<li key=${r.run_id}>
      <a href="/ui/agents/${name}/${r.run_id}">${r.run_id}</a> <${Pill} state=${r.state} />
      <span class="muted">${usd(r.cost_usd)} · ${r.turns} turns · ${r.tool_calls} tools</span></li>`)}</ul>
    <h2>Events</h2><pre class="events">${(d.events || []).join('\n') || 'none'}</pre>
  </div>`;
}
