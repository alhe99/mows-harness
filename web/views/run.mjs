// run.mjs — one run at /agents/<name>/<run>: its status and the assistant text, as the /ui app showed them (MAP 3.2 R-01).
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Pill, usd, base, useUiapp, getJSON } from '../ui.mjs';

/** @param {any} props the route's params ({ name, run }) and whatever else the router passes */
export default function Run({ name, run }) {
  const [d, setD] = useState(/** @type {any} */ (null));
  useUiapp();
  useEffect(() => {
    setD(null);
    getJSON(`/api/agents/${name}/runs/${run}`)
      .then(setD).catch(() => setD(false));
  }, [name, run]);
  if (d === false) return h('p', { class: 'muted', 'data-view': 'run' }, 'No such run.');
  if (!d) return h('p', { class: 'muted', 'data-view': 'run' }, 'Loading…');
  return h('div', { 'data-view': 'run' },
    h('h1', null, h('a', { href: `${base()}/agents/${name}` }, '← ', name), ' ', h('span', { class: 'muted' }, '· ', run)),
    h('p', null, h(Pill, { state: d.status?.state }), ' ', h('span', { class: 'muted' }, `${usd(d.status?.cost_usd)} · ${d.status?.turns} turns`)),
    h('div', { class: 'm claude' }, h('div', { class: 'mh' }, h('b', null, name)), h('pre', null, d.text || '(no assistant text)')));
}
