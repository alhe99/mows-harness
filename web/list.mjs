// list.mjs — what the two list-and-page views (History, Session) share and the others do not: the pager, the size formatter and the live-state
// hook. Its own file so System and Device, which do not use any of it, do not ship it.
import { h } from 'preact';
import { store } from './store.mjs';
import { Icon, base, usePatched } from './shared.mjs';

const iChevronsLeft = '<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/>', iChevronLeft = '<path d="M15 18l-6-6 6-6"/>', iChevronRight = '<path d="M9 18l6-6-6-6"/>', iChevronsRight = '<path d="M6 17l5-5-5-5"/><path d="M13 17l5-5-5-5"/>';
export const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, String(v)); const s = p.toString(); return s ? '?' + s : ''; };
export const fmtSz = n => n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024 | 0) + 'K' : (n / 1048576).toFixed(1) + 'M';

/** The four-icon pager (MAP 2.3 "Pager"): same targets as the legacy nav.pg, as shell links. */
export const Pager = ({ path, params, cur, max, extra }) => {
  const link = (p, d, label) => p >= 1 && p <= max && p !== cur
    ? h('a', { href: base() + path + qs({ ...params, page: p > 1 ? p : '' }), 'aria-label': label, title: label }, h(Icon, { d }))
    : h('span', { class: 'off', 'aria-hidden': 'true' }, h(Icon, { d }));
  return h('nav', { class: 'pg' }, link(1, iChevronsLeft, 'first page'), link(cur - 1, iChevronLeft, 'previous page'),
    h('span', { class: 'pgnum' }, h('span', { class: 'cur' }, cur), h('span', { class: 'muted' }, `/ ${max}`)), extra,
    link(cur + 1, iChevronRight, 'next page'), link(max, iChevronsRight, 'last page'));
};

/** True once a `fleet` event has landed since `data` was read: from then on the fleet signal, not the page's own `live` flags, says what is live. */
export const useFleetPatched = data => usePatched(data, store.fleet);
