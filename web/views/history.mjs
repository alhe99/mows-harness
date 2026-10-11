// history.mjs — the archive at `/history` (MAP 2.3.2). Same markup and class names as the legacy page, so tokens.css styles it unchanged.
// The page is one `HistoryPage` (boot snapshot, then GET /api/history?acct&q&d&s&page): chips, the search form and the pager are shell links,
// so they navigate without a document load. LIVE pills and the live chip follow the store's `fleet` signal once an event has landed.
import { h, Fragment } from 'preact';
import { useEffect, useLayoutEffect } from 'preact/hooks';
import { store } from '../store.mjs';
import { Icon, act, base, hid, relS, useApi } from '../shared.mjs';
import { Pager, fmtSz, qs, useFleetPatched } from '../list.mjs';
import { namedWindows, termHref } from '../term.mjs';

// the glyphs this view draws (legacy ICO path data)
const iSearch = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>';
const iX = '<path d="M18 6 6 18M6 6l12 12"/>';

const dayLbl = ms => {
  const d = new Date(ms).toISOString().slice(0, 10), t = new Date().toISOString().slice(0, 10), y = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return d === t ? 'today' : d === y ? 'yesterday' : new Date(ms).toUTCString().slice(5, 16);
};
/** "-home-demo-Documents-Projects-fun-backend" -> "fun/backend" */
const projName = raw => { const p = raw.replace(/^-/, '').split('-').filter(Boolean); return p.length <= 2 ? p.join('/') : p.slice(-2).join('/'); };
const RANGE = { today: 'today', '7d': '7 days', '30d': '30 days' };
const typing = t => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

function Row({ r, live, name, acct, can, back, done }) {
  const go = acct.term && can
    ? h('a', { class: 'go', 'data-nw': 't-' + r.sid8, href: live && name ? termHref('attach', name) : termHref('open', r.sid8), target: namedWindows() ? 't-' + r.sid8 : undefined,
      title: live ? 'attach (live)' : 'resume in terminal', 'aria-label': live ? 'attach in terminal (live)' : 'resume in terminal' }, '>_') : null;
  const del = live ? null : h('details', { class: 'kx del' },
    h('summary', { class: 'dx', title: 'delete transcript', 'aria-label': 'delete transcript ' + r.sid8 }, h(Icon, { d: iX })),
    h('div', { class: 'kc' }, h('div', null, 'delete ', h('b', null, r.sid8), '?'), h('span', { class: 'muted' }, 'removes the transcript from disk — no undo.'),
      h('form', { class: 'af', method: 'post', action: '/a/del', onSubmit: act(done) }, hid('a', r.a), hid('sid', r.sid), hid('back', back), h('button', { class: 'ab danger' }, 'Delete It'))));
  return h('div', { class: 'li' },
    h('a', { class: 'row', href: `${base()}/s/${r.a}/${r.sid}` },
      h('span', { class: 't' }, relS(r.mt)),
      h('span', { class: 'acct', style: 'color:' + r.acctColor }, acct.label),
      h('span', { class: 'proj' }, projName(r.proj)),
      h('span', { class: 'ttl' }, live ? [h('span', { class: 'lvb' }, h('span', { class: 'lvbd', 'aria-hidden': 'true' }), 'LIVE'), ' '] : null,
        r.title || h('span', { class: 'notitle' }, '(no title)')),
      h('span', { class: 'sz' }, fmtSz(r.sz)), h('span', { class: 'sid' }, r.sid8)),
    go, del);
}

export default function History() {
  const sp = new URLSearchParams(location.search);
  const q = (sp.get('q') || '').toLowerCase().slice(0, 80), d = sp.get('d') || '', s = sp.get('s') || '';
  const [data, reload, err] = useApi('/api/history' + location.search);
  const patched = useFleetPatched(data);
  const fleet = store.fleet.value;
  const liveN = patched ? fleet.length : data?.live ?? 0;

  useLayoutEffect(() => { // the Sessions badge lives in the server's header, outside this view
    const b = document.getElementById('pnav-live');
    if (b && data) { b.textContent = String(liveN); b.hidden = !liveN; }
  }, [liveN, !data]);
  useEffect(() => { // `/` opens the filter and focuses it, unless a field already has the keys
    const key = e => {
      if (e.key !== '/' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(e.target)) return;
      const f = /** @type {HTMLDetailsElement | null} */ (document.querySelector('details.flt'));
      if (!f) return;
      e.preventDefault(); f.open = true;
      /** @type {HTMLElement | null} */ (f.querySelector('input[name=q]'))?.focus();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const head = (label) => h('h1', { 'data-view': 'history' }, h('a', { href: base() + '/' }, 'mows'), ' ', h('span', { class: 'muted' }, '· history'),
    label ? [' ', h('span', { class: 'muted' }, '· ' + label)] : null);
  if (!data) return h(Fragment, null, head(''), h('p', { class: 'muted', style: 'padding:20px 0' }, err ? `could not load the history (${err}).` : 'Loading…'));

  const P = { acct: data.acct, q, d, s };
  const A = Object.fromEntries(data.accts.map(a => [a.id, a]));
  const link = over => base() + '/history' + qs({ ...P, ...over });
  const chip = (over, kids, on, cls = 'sel') => h('a', { class: 'chip' + (on ? ' ' + cls : ''), href: link(over) }, ...kids);
  const dot = c => h('span', { class: 'dot', style: 'background:' + c });
  const live = new Map(fleet.map(f => [f.sid8, f]));
  const fOn = !!(sp.get('acct') || d || s || q);
  const fState = [P.acct && A[P.acct] ? A[P.acct].label : 'all', RANGE[d] || 'all time'].concat(s === 'live' ? ['live'] : [], q ? ['“' + q + '”'] : []).join(' · ');
  const back = location.pathname + location.search;

  let last = '';
  const items = [];
  for (const r of data.rows) {
    const dl = dayLbl(r.mt);
    if (dl !== last) { items.push(h('div', { class: 'day', key: 'day' + dl }, dl)); last = dl; }
    const isLive = patched ? live.has(r.sid8) : r.live;
    items.push(h(Row, { key: r.sid, r, live: isLive, name: live.get(r.sid8)?.name, acct: A[r.a], can: isLive || Date.now() - r.mt < data.resumeDays * 864e5, back, done: () => reload() }));
  }

  return h(Fragment, null, head(data.label),
    h('details', { class: 'sys flt', open: fOn },
      h('summary', null, h('span', { class: 'syst' }, h(Icon, { d: iSearch }), 'filter'),
        h('span', { class: 'syss' }, fState, ' · ', h('b', null, data.total), fOn ? ` of ${data.indexed}` : '', ' sessions')),
      h('div', { class: 'sysbody' },
        h('div', { class: 'bar' }, chip({ acct: '' }, ['all ', h('b', null, data.indexed)], !P.acct),
          ...data.accts.map(a => chip({ acct: a.id }, [dot(a.color), `${a.label} `, h('b', null, a.n)], P.acct === a.id))),
        h('div', { class: 'bar' },
          ...[['', 'all time'], ['today', 'today'], ['7d', '7 days'], ['30d', '30 days']].map(([v, l]) => chip({ d: v }, [l], d === v)),
          chip({ s: s === 'live' ? '' : 'live' }, [dot('var(--ok)'), 'live ', h('b', null, liveN)], s === 'live', 'on'),
          h('form', { action: '/history', method: 'get', onSubmit: e => { e.preventDefault(); store.go(link({ q: new FormData(e.currentTarget).get('q'), page: '' })); } },
            ['acct', 'd', 's'].map(k => P[k] ? hid(k, P[k]) : null),
            h('div', { class: 'fsw' }, h('span', { class: 'fico', 'aria-hidden': 'true' }, h(Icon, { d: iSearch })),
              h('input', { key: q, type: 'search', name: 'q', defaultValue: q, placeholder: 'filter path / id…', 'aria-label': 'Filter by project path or session id' })))))),
    items.length ? h('div', { class: 'hlist' }, items) : h('p', { class: 'muted', style: 'padding:20px 0' }, 'no sessions match.'),
    h(Pager, { path: '/history', params: P, cur: data.page, max: data.pages, extra: h('span', { class: 'pgtot' }, `${data.total} total`) }));
}
