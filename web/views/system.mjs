// system.mjs — `/system` (MAP 2.3.4, 2.2 "System facelift"): host metrics, environment, the restart control, usage and the disk reclaim.
// Same markup and class names as the legacy page. The page is one `ApiSystem` (boot snapshot, then GET /api/system[?reclaim=1]); the `system`
// and `usage` topics overlay the live numbers on it, and the page polls every 4 s while a usage collection runs (the legacy meta refresh).
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { store } from '../store.mjs';
import { Icon, abs, act, base, relS, useApi, usePatched } from '../shared.mjs';

// the glyphs this view draws (legacy ICO path data)
const iRefresh = '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>';
const iTrash = '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>';
const iX = '<path d="M18 6 6 18M6 6l12 12"/>';

const GB = n => (n / 1073741824).toFixed(1);
const HB = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' G' : n >= 1048576 ? (n / 1048576).toFixed(0) + ' M' : (n / 1024).toFixed(0) + ' K';
const money = n => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
const pct = (x, t) => (t ? Math.min(100, Math.round(x / t * 100)) : 0);
const meter = (p, hot) => h('span', { class: 'meter' }, h('i', { style: `width:${Math.min(100, Math.max(0, p))}%${p >= (hot == null ? 101 : hot) ? ';background:var(--bad)' : p >= 50 ? ';background:var(--warn)' : ''}` }));
const section = (title, sub) => h('div', { class: 'sechead' }, h('h2', null, title), h('p', null, sub));

const Bar = ({ label, val, p, warn }) => h('div', { class: 'mbar' },
  h('div', { class: 'mbar-row' }, h('span', { class: 'mbar-label' }, label), h('b', { class: 'mbar-pct' }, Math.round(Math.min(100, Math.max(0, p))) + '%'), h('span', { class: 'mbar-val' }, val)),
  h('div', { class: 'mbar-track' }, h('div', { class: 'mbar-fill' + (warn ? ' warn' : ''), style: `width:${Math.min(100, Math.max(0, p))}%` })));

const erow = (k, v, cls) => h('div', { class: 'envrow' }, h('span', { class: 'envkey' }, k), h('span', { class: 'envval' + (cls ? ' ' + cls : '') }, v));

function Reclaim({ rows, done }) {
  const shown = rows.filter(t => t.b > 0 || t.extra), safe = shown.filter(t => !t.g).reduce((n, t) => n + t.b, 0);
  return h('div', { class: 'statgrid' }, h('div', { class: 'stat wide' }, h('span', { class: 'sl' }, 'reclaim · measured just now'),
    h('form', { class: 'rf', method: 'post', action: '/sys/reclaim', onSubmit: act(done, true) },
      shown.length ? shown.map(t => h('label', { class: 'rrow', key: t.id }, h('input', { type: 'checkbox', name: 't', value: t.id, defaultChecked: !t.g }),
        h('span', { class: 'rl' }, t.label), h('b', null, HB(t.b)), h('span', { class: 'muted' }, t.extra ? t.extra + ' · ' + t.note : t.note)))
        : h('div', { class: 'mlist muted' }, 'nothing to reclaim — every cache here is already empty'),
      shown.length ? h(Fragment, null,
        h('div', { class: 'rrow tot' }, h('span', { class: 'rl' }, 'checked by default'), h('b', null, HB(safe)), h('button', { class: 'ab danger' }, h(Icon, { d: iTrash }), 'Reclaim Selected')),
        h('div', { class: 'mlist muted' }, 'runs as root · no undo. memory and cpu are missing on purpose: the mem bar above already excludes the page cache, so there is nothing there to free, and the load is your own sessions.')) : null)));
}

function Account({ a, u, now }) {
  const q = u.quota[a.qkey] || u.quota[a.label] || {};
  const qrow = (lbl, v) => h('div', { class: 'qrow' }, h('span', null, lbl), meter(v == null ? 0 : v, u.thr), h('b', null, v == null ? '?' : v + '%'));
  const mlist = (cls, ...k) => h('div', { class: 'mlist' + (cls ? ' ' + cls : '') }, ...k);
  const sub = (...k) => h('span', { class: 'muted mlist', style: 'padding:0' }, ...k);
  return h(Fragment, null,
    h('div', { class: 'stat' }, h('span', { class: 'sl' }, a.label + ' · limits'), qrow('5h', q.h5), qrow('week', q.wk),
      mlist('muted', a.tokExp && a.tokExp < now && q.h5 == null ? `oauth token expired ${relS(a.tokExp, now)} ago — open any ${a.label} session and it refreshes` : `threshold ${u.thr}%`)),
    h('div', { class: 'stat' }, h('span', { class: 'sl' }, a.label + ' · spend'),
      !a.cc ? mlist('muted', 'ccusage not installed — sudo npm i -g ccusage') : h(Fragment, null,
        h('div', { class: 'qrow' }, h('span', null, 'today'), h('b', null, money(a.today)), h('span', { class: 'muted' }, `· week ${money(a.week)} · month ${money(a.month)}`)),
        a.block ? h('div', { class: 'qrow' }, h('span', null, '5h block'), h('b', null, money(a.block.cost)), h('span', { class: 'muted' }, `· ${money(a.block.rate)}/h burn`)) : null,
        mlist(a.models.length ? '' : 'muted', a.models.length ? a.models.map(m => `${m.name.replace(/^claude-/, '')} ${money(m.cost)}`).join(' · ') : 'no usage today'),
        h('details', { class: 'ubd' }, h('summary', null, 'full breakdown · 7 days'),
          h('span', { class: 'sl', style: 'padding-top:8px' }, 'per day'),
          a.days.length ? a.days.map(r => h('div', { class: 'qrow', key: r.d }, h('span', null, r.d.slice(5)), h('b', null, money(r.cost)), sub(r.models.join(', ')))) : mlist('muted', 'no usage this week'),
          h('span', { class: 'sl', style: 'padding-top:8px' }, 'sessions · lifetime spend'),
          a.sess.length ? a.sess.map(t => h('div', { class: 'qrow', key: t.sid }, h('a', { class: 'sid8', href: `${base()}/s/${a.id}/${t.sid}` }, t.sid.slice(0, 8)), h('b', null, money(t.cost)), sub(t.models.join(', ')))) : mlist('muted', 'none this week')))));
}

export default function System() {
  const reclaiming = !!new URLSearchParams(location.search).get('reclaim');
  const [d, reload, err] = useApi('/api/system' + location.search);
  const [flash, setFlash] = useState(/** @type {{ freed?: number, n?: number, rs?: number }} */ ({}));
  // the page's own numbers until the stream says something newer: a `system` or `usage` event that lands after the page was read
  const sys = usePatched(d, store.system) ? store.system.value : null, uq = usePatched(d, store.usage) ? store.usage.value : null;
  useEffect(() => { // a collection runs: ask again in 4 s, until it lands
    if (!d?.busy) return;
    const t = setTimeout(() => reload(), 4000);
    return () => clearTimeout(t);
  }, [d]);
  useEffect(() => { if (uq && (!d?.usage || d.busy)) reload(); }, [uq]); // numbers arrived over the stream before the page had them

  const head = h('h1', { 'data-view': 'system' }, h('a', { href: base() + '/' }, 'mows'), ' ', h('span', { class: 'muted' }, '· system'));
  if (!d) return h(Fragment, null, head, h('p', { class: 'muted' }, err ? `could not load the system page (${err}).` : 'Loading…'));

  const m = sys || d, days = Math.floor(m.up / 86400), hrs = Math.floor(m.up % 86400 / 3600);
  const live = store.fleet.value.length;
  const u = d.usage && { ...d.usage, ...(uq && { quota: uq.quota, thr: uq.thr }), accts: Object.fromEntries(Object.entries(d.usage.accts).map(([k, a]) => [k, { ...a, ...uq?.accts?.[k] }])) };
  const memPct = pct(m.memUsed, m.memTot), swapPct = m.swapTot ? pct(m.swapUsed, m.swapTot) : 0, diskPct = pct(m.dskUsed, m.dskTot);
  const refresh = e => { e.preventDefault(); fetch('/api/usage/refresh', { method: 'POST' }).then(() => reload()).catch(() => {}); };
  // ages are read against the server's clock (legacy rendered them there), so a viewer's skewed clock cannot misreport them
  const ago = ms => (relS(ms, d.now) === 'now' ? 'now' : relS(ms, d.now) + ' ago');
  const age = d.usageAt ? ago(d.usageAt) : '—';

  return h(Fragment, null, head, h('div', { class: 'sysview' },
    h('div', { class: 'sysgrid' },
      h('section', { class: 'sysleft' }, section('Metrics', 'Live utilization of host resources.'),
        h('div', { class: 'mbars' },
          h(Bar, { label: 'Load average', val: `${m.load.toFixed(2)} / ${m.cores} cores`, p: pct(m.load, m.cores), warn: m.load > m.cores }),
          h(Bar, { label: 'Memory', val: `${GB(m.memUsed)} / ${GB(m.memTot)} G`, p: memPct, warn: memPct > 85 }),
          h(Bar, { label: 'Swap', val: m.swapTot ? `${GB(m.swapUsed)} / ${GB(m.swapTot)} G` : 'not configured', p: swapPct, warn: swapPct > 85 }),
          h(Bar, { label: 'Disk /', val: `${GB(m.dskUsed)} / ${GB(m.dskTot)} G`, p: diskPct, warn: diskPct > 85 }))),
      h('div', { class: 'sysright' },
        h('section', { class: 'sysright-item' }, section('Environment', 'System configuration and status.'),
          h('div', { class: 'envcard' }, h('div', { class: 'envrows' },
            erow('STATUS', [h('span', { class: 'edot' }), 'ONLINE'], 'ok'), erow('VERSION', m.version || '?'), h('div', { class: 'envdiv' }),
            erow('UPTIME', `${days}d ${hrs}h`), erow('LAST_DEPLOY', h('span', { title: d.deployed ? abs(d.deployed) : '' }, d.deployed ? ago(d.deployed).replace(/^now$/, 'just now') : '?')), h('div', { class: 'envdiv' }),
            erow('NODE', d.node), erow('OS', d.platform)))),
        h('section', { class: 'sysright-item' }, section('Terminal', 'Master process and theming.'),
          h('div', { class: 'termcard set' }, h('div', { class: 'seclabel' }, 'Master process'),
            live ? h('details', { class: 'kx' }, h('summary', { class: 'dangerbtn' }, h(Icon, { d: iRefresh }), 'Restart All Sessions', live > 1 ? ` (${live})` : ''),
              h('div', { class: 'kc' }, h('div', null, 'restart all ', h('b', null, live), ` live session${live > 1 ? 's' : ''}?`),
                h('span', { class: 'muted' }, 'whatever is running right now is killed — including the session you are reading this from.'),
                h('form', { class: 'af', method: 'post', action: '/a/restartall', onSubmit: act(r => { setFlash({ rs: r.rs }); reload(); }, true) },
                  h('button', { class: 'ab danger' }, 'Restart Them'))))
              : h('div', { class: 'dangerbtn off', 'aria-disabled': 'true' }, h(Icon, { d: iRefresh }), 'restart all sessions'),
            h('p', { class: 'dangercap' }, live ? 'Restarts every live terminal session on this host — including the one you’re reading this from. Transcripts stay on disk; nothing is deleted.' : 'No live sessions right now — nothing to restart.'),
            flash.rs ? h('span', { class: 'chip on' }, h('span', { class: 'dot', style: 'background:var(--ok)' }), 'restarted ' + flash.rs) : null)))),
    h('div', { class: 'sysextra' }, section('Usage & Reclaim', 'Claude account limits, daily spend, and disk reclaim.'),
      h('div', { class: 'bar' }, h('span', { class: 'chip' }, 'usage updated ', h('b', null, age), d.busy ? ' · refreshing…' : ''),
        h('a', { class: 'chip', href: base() + '/system?fresh=1', onClick: refresh }, h(Icon, { d: iRefresh }), 'Refresh'),
        h('a', { class: 'chip', href: base() + (reclaiming ? '/system' : '/system?reclaim=1') }, h(Icon, { d: reclaiming ? iX : iTrash }), reclaiming ? 'Close' : 'Reclaim'),
        flash.freed != null ? h('span', { class: 'chip ok' }, 'reclaimed ', h('b', null, HB(flash.freed)), ` · ${flash.n} target${flash.n === 1 ? '' : 's'}`) : null),
      reclaiming && d.reclaim ? h(Reclaim, { rows: d.reclaim, done: async r => {
        setFlash({ freed: r.freed, n: r.n });
        await store.getJson('/api/system', true).catch(() => {}); // the disk meter must show the new number
        store.go(base() + '/system');
      } }) : null,
      u ? h('div', { class: 'statgrid u' }, Object.values(u.accts).map(a => h(Account, { key: a.id, a, u, now: d.now })))
        : h('p', { class: 'muted', style: 'padding:4px 0 8px' }, 'collecting usage — first pass takes ~15 s, refresh in a moment…'))));
}
