// agent.mjs — one agent at /agents/<name>: the chat card on the left, five aside cards on the right (MAP 8 M-07, 3.5 S-07..S-09).
// The chat card (chat.mjs) and the capability panel with the card summary (capability.mjs) are lazy chunks of their own.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { store } from '../store.mjs';
import { Pill, usd, base, useUiapp, getJSON } from '../ui.mjs';

// A telemetry row renders NOTHING when its value is absent, rather than an em-dash placeholder. capability is null whenever the
// agent file could not be read or parsed, and a card of confident "—"s is exactly the misreading the capability module exists to
// prevent: an absent row says "not stated", a dash says "stated as nothing".
const Row = ({ k, v }) => v == null || v === '' ? null
  : h('div', { class: 'trow' }, h('span', { class: 'tk' }, k), h('span', { class: 'tv' }, v));

// A run id is YYYYMMDD-HHMMSS-PID. The comp renders it "17:32-2473" — short enough for a 320px column, and the form used here. But
// that shape is only unambiguous WITHIN A DAY: two runs at 17:32 a week apart print identically, and this list holds the last
// twenty runs, not the last day's. So the date comes back as soon as it is doing work — today's runs read exactly as the comp,
// older ones carry "09-16" in front. The full id stays in the title either way. Anything that does not match the pattern is
// returned untouched rather than sliced blindly.
const RUN_ID = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)\d\d-(\d{1,4})/;
export function runLabel(id, now = new Date()) {
  const m = RUN_ID.exec(id);
  if (!m) return id;
  const [, y, mo, d, hh, mm, pid] = m;
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `${y + mo + d === today ? '' : `${mo}-${d} `}${hh}:${mm}-${pid}`;
}

function Telemetry({ policy }) {
  if (!policy) return h('p', { class: 'muted' }, 'Its agent file could not be read, so nothing here is known.');
  const b = policy.budget || {};
  // Budget and Daily Cap are each built from two fields that can independently be missing, so they are assembled rather than
  // templated: a literal `$${x} / ${y} turns` prints "$undefined" the moment one half is absent, which is the flattering-when-wrong
  // failure this file avoids.
  const budget = [b.usd_per_run != null && `$${(+b.usd_per_run).toFixed(2)}`,
                  b.max_turns != null && `${b.max_turns} turns`].filter(Boolean).join(' / ');
  const daily = b.usd_per_day != null ? `$${(+b.usd_per_day).toFixed(2)} per day` : null;
  return h('div', { class: 'tgrid' },
    h(Row, { k: 'Profile', v: policy.profile }), h(Row, { k: 'Soul', v: policy.soul }), h(Row, { k: 'Target', v: policy.workdir }),
    h(Row, { k: 'Trigger', v: policy.triggerTypes?.join(', ') }), h(Row, { k: 'Budget', v: budget }), h(Row, { k: 'Daily Cap', v: daily }));
}

/** @param {any} props the route's params ({ name }) and whatever else the router passes */
export default function Agent({ name }) {
  const [d, setD] = useState(/** @type {any} */ (null));
  // chat.mjs and capability.mjs are chunks of their own (K-02), requested as the view mounts, beside the data
  const [cap, setCap] = useState(/** @type {any} */ (null)), [chat, setChat] = useState(/** @type {any} */ (null));
  useEffect(() => {
    setD(null);
    getJSON(`/api/agents/${name}`)
      .then(setD).catch(() => setD(false));
  }, [name]);
  useEffect(() => { import('./capability.mjs').then(setCap); import('./chat.mjs').then(setChat); }, []);
  // The chat deltas of this agent ride the tab's one stream (K-13). The topic is held from the moment the view mounts — well before
  // the transcript and the chat chunk are in — so the stream is already subscribed when the card appears.
  useEffect(() => store.watch(`chat:${name}`), [name]);
  // This page is a chat screen. On a phone it owns the whole viewport, like any messaging app: the stylesheet hides the terminal
  // FAB while html.agent-view is set, and the header's ← is the way out. A class, not a style (CSP). With no fixed bottom chrome
  // lifted by the iOS keyboard there is nothing for it to lift (the tab bar hides on composer focus, html.kb-open).
  useUiapp('agent-view');
  if (d === false) return h('p', { class: 'muted', 'data-view': 'agent' }, 'No such agent.');
  if (!d) return h('p', { class: 'muted', 'data-view': 'agent' }, 'Loading…');
  const live = d.recs?.[0]?.state === 'working';
  const model = d.capability?.policy?.model;
  const home = `${base()}/agents`;
  return h('div', { class: 'agwrap', 'data-view': 'agent' },
    h('a', { class: 'agback', href: home }, '← agents'),
    h('div', { class: 'ag2' },
      h('section', { class: 'agchat' },
        // Phone-only back control, in the header where iOS puts one. The desktop comp has a separate "← agents" line above the card
        // (.agback); one of the two is shown per breakpoint, by CSS.
        h('header', { class: 'agh' },
          h('a', { class: 'agback-in', href: home, 'aria-label': 'Back to agents' }, '←'),
          h('span', { class: 'agav', 'aria-hidden': 'true' }),
          h('div', { class: 'agti' },
            h('h1', null, name, live && [' ', h('span', { class: 'agdot', title: 'running' })]),
            h('p', { class: 'agsub' }, [model, `${usd(d.cost7d)} spent`].filter(Boolean).join(' · '))),
          h('form', { class: 'agctl', method: 'post', action: '/a/agent-run' },
            h('input', { type: 'hidden', name: 'name', value: name }),
            h('input', { type: 'hidden', name: 'back', value: `${home}/${name}` }),
            h('button', { class: 'cbtn', title: 'Run now', 'aria-label': 'Run now' }))),
        // The comp's hint line names four tools. It is passed ONLY when the agent file gave a genuine explicit list: `effective` is
        // null whenever the agent inherits, and printing a short confident list for the file that is actually least restricted is
        // the exact inversion capability.mjs exists to prevent. Inheriting agents get no hint line.
        chat && h(chat.Chat, { name, events: d.events, tools: d.capability?.effective?.length ? d.capability.effective.join(', ') : null })),
      h('aside', { class: 'agside' },
        h('div', { class: 'card' }, h('h2', { class: 'cl' }, 'Agent Telemetry'), h(Telemetry, { policy: d.capability?.policy })),
        // The comp's Capabilities card is chips plus one amber line. Ours is the full honest panel, which runs ~1000px and pushed
        // Recent Runs off the fold. The answer is NOT to trim the panel — it is the safety surface — so the comp's summary is
        // surfaced (chips and the strongest authority, both from the SAME structured fields the panel renders) and the full report
        // sits one disclosure below it, losing nothing.
        h('div', { class: 'card' }, h('h2', { class: 'cl' }, 'Capabilities'), cap && h(cap.CapSummary, { capability: d.capability }),
          h('details', { class: 'capmore' }, h('summary', null, 'Full capability report'),
            cap && h(cap.CapabilityPanel, { capability: d.capability }))),
        h('div', { class: 'card' }, h('h2', { class: 'cl' }, 'Recent Runs'),
          (d.recs || []).length
            ? h('ul', { class: 'rruns' }, d.recs.map(r => h('li', { key: r.run_id },
              h(Pill, { state: r.state }),
              h('a', { href: `${home}/${name}/${r.run_id}`, title: r.run_id }, runLabel(r.run_id)),
              h('span', { class: 'rcost' }, usd(r.cost_usd)))))
            : h('p', { class: 'muted' }, 'Never run.')),
        // The agent's working memory (spec 2026-09-19), read-only. null and '' are different states and both are shown as words:
        // null means mows-agent has never stored one, '' means the agent emitted an empty block — cleared it on purpose. A <pre> of
        // the text otherwise; the file is Markdown but rendering it would invite the same injection surface the chat view had to close.
        h('div', { class: 'card' }, h('h2', { class: 'cl' }, 'Memory'),
          d.memory == null ? h('p', { class: 'muted' }, 'No memory yet.')
            : d.memory === '' ? h('p', { class: 'muted' }, 'Cleared by the agent.')
            : h('pre', { class: 'mem' }, d.memory)),
        // Collapsed rather than deleted: the only place the raw unit log is readable. Shut, it costs the design one hairline.
        h('details', { class: 'card agev' }, h('summary', null, 'Events'),
          h('pre', { class: 'events' }, (d.events || []).join('\n') || 'none')))));
}
