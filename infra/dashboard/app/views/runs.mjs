import { useState, useEffect } from 'preact/hooks';
import { html, Pill, usd } from '../ui.mjs';
import { getJSON } from '../store.mjs';

export function RunView({ name, run }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); getJSON(`/api/agents/${name}/runs/${run}`).then(setD).catch(() => setD(false)); }, [name, run]);
  if (d === false) return html`<p class="muted">No such run.</p>`;
  if (!d) return html`<p class="muted">Loading…</p>`;
  return html`<div>
    <h1><a href="/ui/agents/${name}">← ${name}</a> <span class="muted">· ${run}</span></h1>
    <p><${Pill} state=${d.status?.state} /> <span class="muted">${usd(d.status?.cost_usd)} · ${d.status?.turns} turns</span></p>
    <div class="m claude"><div class="mh"><b>${name}</b></div><pre>${d.text || '(no assistant text)'}</pre></div>
  </div>`;
}
