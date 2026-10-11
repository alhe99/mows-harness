// session.mjs — one transcript at `/s/<acct>/<sid>` (MAP 2.3.3). Same markup and class names as the legacy page. The page is one `ApiSession`
// (boot snapshot, then GET /api/session/<acct>/<sid>?page=): newest page of 25 items first, chronological inside it. Live state follows the
// store's `fleet` signal once an event has landed; the pause/resume/rename/kill forms post with fetch and the page reloads.
import { h, Fragment } from 'preact';
import { store } from '../store.mjs';
import { Icon, abs, act, base, hid, relS, useApi } from '../shared.mjs';
import { Pager, fmtSz, useFleetPatched } from '../list.mjs';
import { namedWindows, termHref } from '../term.mjs';

// the glyphs this view draws (legacy ICO path data)
const iPause = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
const iPencil = '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>';
const iPlay = '<path d="M6 4l14 8-14 8z"/>';
const iWrench = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
const iX = '<path d="M18 6 6 18M6 6l12 12"/>';

function Msg({ m }) {
  if (m.role === 'tool') return h('details', null, h('summary', null, h(Icon, { d: iWrench }), ' ' + m.name), h('pre', null, m.text));
  if (m.role === 'res') return h('details', null, h('summary', null, '↳ result'), h('pre', null, m.text));
  if (m.role === 'sum') return h('details', null, h('summary', null, '⟲ compaction summary'), h('pre', null, m.text));
  return h('div', { class: 'm ' + m.role }, h('div', { class: 'mh' }, h('b', null, m.role === 'user' ? 'you' : 'claude'), ' · ' + (m.ts ? m.ts.slice(11, 19) : '')),
    m.text.length > 2500 ? h('details', null, h('summary', null, m.text.slice(0, 200) + '…'), h('pre', null, m.text)) : h('pre', null, m.text));
}

/** @param {any} props the route's :acct and :sid */
export default function Session({ acct, sid }) {
  const [s, reload, err] = useApi(`/api/session/${acct}/${sid}${location.search}`);
  const patched = useFleetPatched(s);
  const f = store.fleet.value.find(x => x.sid8 === sid.slice(0, 8));
  const head = h('h1', { 'data-view': 'session' }, h('a', { href: base() + '/' }, '← sessions'));
  if (!s) return h(Fragment, null, head, h('p', { class: 'muted' }, err === '404' ? 'session not found.' : err ? `could not read the transcript (${err}).` : 'Loading…'));

  const lv = patched ? (f ? { name: f.name, paused: f.state === 'paused', label: f.label } : null) : s.live;
  const back = location.pathname + location.search, sid8 = s.sid8, done = () => reload();
  const aform = (action, kids, cls = 'af') => h('form', { class: cls, method: 'post', action, onSubmit: act(done) }, hid('name', lv.name), hid('back', back), ...kids);
  const simple = (act2, label, cls, d) => aform('/a/' + act2, [h('button', { class: 'ab' + (cls ? ' ' + cls : '') }, d ? h(Icon, { d, solid: d === iPlay }) : null, label)]);
  const can = !!lv || Date.now() - s.mt < s.resumeDays * 864e5;
  const meta = [['session', [s.sid, ' ', lv ? h('span', { class: 'lvb' }, h('span', { class: 'lvbd', 'aria-hidden': 'true' }), 'LIVE') : null]],
    ['account', h('span', { style: 'color:' + s.acct.color }, s.acct.label)], ['project', s.proj], ['started', abs(s.started)], ['last', `${abs(s.mt)} (${relS(s.mt)} ago)`],
    ['size', `${fmtSz(s.sz)} · ${s.items} items · ${s.tools} tool calls${s.model ? ' · ' + s.model : ''}`]];
  const pager = h(Pager, { path: `/s/${acct}/${sid}`, params: {}, cur: s.page, max: s.pages, extra: h('span', { class: 'pgtot' }, `${s.items} items · newest first`) });

  return h(Fragment, null, head,
    h('div', { class: 'meta' }, meta.map(([k, v]) => h(Fragment, { key: k }, h('div', null, k), h('div', null, v)))),
    s.acct.term ? (can
      ? h('div', { class: 'la', style: 'justify-content:flex-start' },
        h('a', { class: 'btn', 'data-nw': 't-' + sid8, href: lv ? termHref('attach', lv.name) : termHref('open', sid8), target: namedWindows() ? 't-' + sid8 : undefined },
          '>_ ' + (lv ? (lv.paused ? 'attach — paused' : 'attach — live now') : 'open in terminal')),
        lv ? h(Fragment, null,
          lv.paused ? simple('resume', 'Resume', 'ok', iPlay) : simple('pause', 'Pause', '', iPause),
          h('details', { class: 'kx', name: 'am' }, h('summary', { class: 'ab', title: 'name this session' }, h(Icon, { d: iPencil })),
            h('div', { class: 'kc' }, aform('/a/label', [h('span', { class: 'klbl' }, 'Rename'),
              h('input', { class: 'li2', name: 'label', defaultValue: lv.label || '', maxlength: 60, placeholder: 'session name', 'aria-label': 'session name' }), h('button', { class: 'ab ok' }, 'Save')], 'af lf'))),
          h('details', { class: 'kx', name: 'am' }, h('summary', { class: 'ab danger' }, h(Icon, { d: iX }), 'Kill'),
            h('div', { class: 'kc' }, h('div', null, 'stop ', h('b', null, lv.name), '?'),
              h('span', { class: 'muted' }, 'the process ends now — the transcript stays on disk, resume anytime.'), simple('kill', 'Kill It', 'danger')))) : null)
      : h('p', { class: 'muted', style: 'margin:8px 0' }, `resume disabled — idle ${relS(s.mt)} (cutoff ${s.resumeDays}d). transcript stays readable; resume manually with `,
        h('span', { style: 'font-family:var(--mono)' }, 'cc -r'), ' if you really need it.')) : null,
    s.truncated ? h('div', { class: 'note' }, 'large transcript — showing the most recent 8MB window.') : null,
    pager, s.msgs.length ? s.msgs.map((m, i) => h(Msg, { key: i, m })) : h('p', { class: 'muted' }, 'no displayable messages.'), pager);
}
