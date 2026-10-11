// agents.mjs — the agent list at /agents (MAP 8 M-07, 3.5 S-07..S-09). The rows are the store's `agents` signal: seeded by the boot
// snapshot, replaced by every `agents` event, which is a FULL SNAPSHOT each tick, so the snapshot decides membership — a new agent
// appears and a removed one goes away. Only a view reached from another route (no boot data yet) asks /api/agents once.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { store } from '../store.mjs';
import { Pill, usd, rel, base, useUiapp } from '../ui.mjs';

export default function Agents() {
  useUiapp();
  const rows = store.agents.value;
  const [loaded, setLoaded] = useState(rows.length > 0);
  useEffect(() => {
    if (loaded) return;
    store.getJson('/api/agents').then(d => { if (!store.agents.peek().length) store.agents.value = d.agents; }).catch(() => {}).then(() => setLoaded(true));
  }, []);
  if (!rows.length) return h('p', { class: 'muted', 'data-view': 'agents' }, loaded ? 'No agents yet.' : 'Loading…');
  return h('div', { 'data-view': 'agents' },
    h('h1', null, 'agents'),
    rows.map(a => h('a', { class: 'agent card', href: `${base()}/agents/${a.name}`, key: a.name },
      h('b', null, a.name), ' ', h(Pill, { state: a.state }),
      h('span', { class: 'muted' }, `${a.last_event_at ? rel(Date.parse(a.last_event_at)) : 'never ran'} · ${a.total} runs · 7d ${usd(a.cost7d)}`))));
}
