// sessions.mjs — the fleet at `/` (MAP 2.3.1, 2.4 "/fleet.js internals"). Rows (>= 701 px) and cards (<= 700 px) share the markup
// and class names of the legacy page, so tokens.css styles them unchanged. Lists render keyed from the store's `fleet` signal (seeded
// by the boot snapshot, patched by `fleet` events), so a reorder moves nodes and a patch changes text; nothing is rebuilt.
import { h, Fragment } from 'preact';
import { useEffect, useLayoutEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { store } from '../store.mjs';
import { base } from '../shared.mjs';

const GLYPH = { 'needs-you': '◉', working: '●', paused: '⏸', idle: '○' };
const WORD = { 'needs-you': 'waiting', working: 'working', paused: 'paused', idle: 'idle' };
const ORDER = { 'needs-you': 0, working: 1, paused: 2, idle: 3 };
const relStr = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'now' : s < 5400 ? (s / 60 | 0) + 'm' : s < 129600 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };

/** The terminal document's URL; every render mints a fresh 8-hex tab id, the key web-term.sh uses to find this browser tab's tmux client. */
export const termHref = (kind, name) => `/term/?arg=${kind}&arg=${encodeURIComponent(name)}&arg=${[...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')}&v=3`;
// a named window per session, in a desktop BROWSER only: the installed app has no second window, and a touch device has nowhere to put one
const namedWindows = () => matchMedia('(display-mode: browser)').matches && innerWidth >= 700 && matchMedia('(pointer:fine)').matches;
// where the grid runs (views/grid.mjs desktop(): a mouse, >= 1024 px) a row opens its session as a pane of /grid, in this tab; a phone, a
// narrow window or the installed app keep the terminal document of its own (2026-10-12)
const gridDesk = () => matchMedia('(pointer:fine)').matches && innerWidth >= 1024;

const filter = signal('');
const now = signal(0); // bumped every 30 s: relative times re-render between snapshots

const icon = (attrs, ...kids) => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', ...attrs }, ...kids);
const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const solid = { fill: 'currentColor', stroke: 'none' };
const Play = () => icon(solid, h('path', { d: 'M6 4l14 8-14 8z' }));
const Pause = () => icon(line, h('rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }), h('rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }));
const X = () => icon(line, h('path', { d: 'M18 6 6 18M6 6l12 12' }));
const Ellipsis = () => icon(solid, h('circle', { cx: 5, cy: 12, r: 1.6 }), h('circle', { cx: 12, cy: 12, r: 1.6 }), h('circle', { cx: 19, cy: 12, r: 1.6 }));

// Every action is a real <form method=post> that PRG-redirects, and works as one without script. Here it is sent with fetch instead,
// so the page keeps its place; `redirect: 'manual'` skips the GET of the page the 303 points at (the fleet arrives over /stream).
async function post(e) {
  const form = /** @type {HTMLFormElement} */ (e.currentTarget);
  e.preventDefault();
  if (form.classList.contains('busy')) return;
  form.classList.add('busy');
  try {
    await fetch(form.action, { method: 'POST', body: new URLSearchParams(/** @type {any} */ (new FormData(form))), redirect: 'manual' });
    form.closest('details[name=fm]')?.removeAttribute('open');
  } catch { /* offline: the busy state clears and the menu stays open for another try */ }
  form.classList.remove('busy');
}
const hid = (name, value, f) => h('input', { type: 'hidden', name, value, 'data-f': f });
const form = (action, cls, extra, ...kids) => h('form', { class: cls, method: 'post', action, onSubmit: post, ...extra }, ...kids);

function Menu({ f, back }) {
  const paused = f.state === 'paused', ids = [hid('name', f.name, 'nameinput'), hid('back', back)];
  return h('details', { class: 'kx', name: 'fm' },
    h('summary', { class: 'ab', title: 'more actions' }, h(Ellipsis, null)),
    h('div', { class: 'kc' },
      h('div', { class: 'tname', 'data-f': 'tname' }, f.name),
      form(paused ? '/a/resume' : '/a/pause', 'af', { 'data-f': 'pauseform' }, ...ids,
        h('button', { class: paused ? 'ab ok' : 'ab', 'data-f': 'pausebtn' }, paused ? h(Play, null) : h(Pause, null), paused ? 'Resume' : 'Pause')),
      form('/a/label', 'af lf', {}, ...ids, h('span', { class: 'klbl' }, 'Rename'),
        h('input', { class: 'li2', name: 'label', defaultValue: f.label || '', maxlength: 60, placeholder: 'session name', 'aria-label': 'session name', 'data-f': 'labelinput' }),
        h('button', { class: 'ab ok' }, 'Save')),
      h('details', { class: 'kx' },
        h('summary', { class: 'ab danger' }, h(X, null), 'Kill'),
        h('div', { class: 'kc' },
          h('div', null, 'stop ', h('b', { 'data-f': 'killname' }, f.name), '?'),
          h('span', { class: 'muted' }, 'the process ends now — the transcript stays on disk, resume anytime.'),
          form('/a/kill', 'af', {}, ...ids, h('button', { class: 'ab danger' }, 'Kill It'))))));
}

const glyph = f => h('span', { class: `fli fli-${f.state}`, 'aria-hidden': 'true', 'data-f': 'glyph' }, GLYPH[f.state]);
const attach = (f, cls, extra) => (gridDesk()
  ? h('a', { class: cls, 'data-f': 'attach', href: `${base()}/grid?open=${encodeURIComponent(f.name)}`, title: 'attach (in the grid)', 'aria-label': 'attach ' + f.name, ...extra }, '>_')
  : h('a', { class: cls, 'data-nw': 't-' + f.name, 'data-f': 'attach', href: termHref('attach', f.name),
    title: 'attach', 'aria-label': 'attach ' + f.name, target: namedWindows() ? 't-' + f.name : undefined, ...extra }, '>_'));
const snip = (f, extra) => h('div', { class: 'fsnip', 'data-f': 'snip', style: f.snippet ? extra : (extra ? extra + ';' : '') + 'display:none' }, f.snippet);

function Row({ f, i, back, show }) {
  return h('div', { class: 'li', 'data-sid': f.sid8, 'data-state': f.state, style: show ? undefined : 'display:none' },
    h('div', { class: 'frow' },
      h('div', { class: 'fr1' },
        glyph(f),
        h('span', { class: 'lb', 'data-f': 'label' }, f.label || f.proj || f.name),
        h('span', { class: 'proj', 'data-f': 'proj' }, f.proj),
        h('span', { class: 'fact' },
          h('span', { class: 'fnum', 'data-f': 'num', 'aria-hidden': 'true' }, i < 9 ? String(i + 1) : ''),
          attach(f, 'go'), h(Menu, { f, back })),
        h('span', { class: 'fst', 'data-f': 'meta' }, `${WORD[f.state]} ${relStr(f.rel)}`)),
      h('span', { class: 'fsnip', 'data-f': 'snip', style: f.snippet ? undefined : 'display:none' }, f.snippet)));
}

function Card({ f, back, show }) {
  return h('div', { class: 'lp', 'data-sid': f.sid8, 'data-state': f.state, style: show ? undefined : 'display:none' },
    h('div', { class: 'lr fchd', style: 'justify-content:space-between' },
      h('span', { class: 'lb' }, glyph(f), ' ', h('span', { 'data-f': 'label' }, f.label || f.proj || f.name)),
      h('span', { class: 'fcact' }, attach(f, 'ab ok', { style: 'font:700 13px var(--mono)' }), h(Menu, { f, back }))),
    h('div', { class: 'muted', style: 'font-size:12.5px' }, h('span', { 'data-f': 'proj' }, f.proj), ' · ', h('span', { 'data-f': 'meta' }, `${WORD[f.state]} ${relStr(f.rel)}`)),
    snip(f, 'font-size:12.5px'));
}

// 1-9 attach the nth row (rows only: they carry the on-screen numbers), `/` focuses the filter; never while typing
function onKey(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (/^[1-9]$/.test(e.key)) {
    const a = document.getElementById('fleet-rows')?.children[+e.key - 1]?.querySelector('[data-f=attach]');
    if (a) { e.preventDefault(); /** @type {HTMLElement} */ (a).click(); } // a click, not a location change: data-nw window reuse stays as is
  } else if (e.key === '/') {
    const ff = /** @type {HTMLElement | null} */ (document.querySelector('[data-f=filter]'));
    if (ff) { e.preventDefault(); ff.focus(); }
  }
}

export default function Sessions() {
  now.value; // subscribe: relative times follow the 30 s tick
  const fleet = [...store.fleet.value].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.rel - a.rel);
  const n = fleet.length, term = filter.value.trim().toLowerCase();
  const back = location.pathname + location.search;
  const show = f => !term || `${f.label || f.proj || f.name} ${f.proj} ${f.snippet}`.toLowerCase().includes(term);

  useLayoutEffect(() => { // the Sessions badge lives in the server's header, outside this view
    const b = document.getElementById('pnav-live');
    if (b) { b.textContent = String(n); b.hidden = !n; }
  }, [n]);
  useEffect(() => {
    const tick = setInterval(() => { now.value++; }, 30000);
    // a restored page must not keep a form greyed out
    const clear = () => document.querySelectorAll('form.busy').forEach(f => f.classList.remove('busy'));
    addEventListener('pageshow', clear);
    document.addEventListener('keydown', onKey);
    return () => { clearInterval(tick); removeEventListener('pageshow', clear); document.removeEventListener('keydown', onKey); };
  }, []);

  return h(Fragment, null,
    h('h1', { 'data-view': 'sessions' }, h('a', { href: (document.documentElement.dataset.base || '') + '/' }, 'mows')),
    h('div', { class: 'sect' }, 'fleet ', h('b', { id: 'fleet-count', hidden: !n }, n),
      h('input', { type: 'search', 'data-f': 'filter', placeholder: 'filter…', 'aria-label': 'filter fleet sessions', autocomplete: 'off', value: filter.value,
        onInput: e => { filter.value = e.currentTarget.value; },
        style: 'margin-left:8px;width:120px;min-height:0;padding:3px 8px;vertical-align:middle' })),
    h('p', { class: 'muted', id: 'fleet-empty', hidden: !!n, style: 'padding:8px 4px 16px' }, 'no live sessions.'),
    h('div', { class: 'fleet-rows', id: 'fleet-rows' }, fleet.map((f, i) => h(Row, { key: f.sid8, f, i, back, show: show(f) }))),
    h('div', { class: 'fleet-cards', id: 'fleet-cards' }, fleet.map(f => h(Card, { key: f.sid8, f, back, show: show(f) }))),
    h('a', { class: 'newcard', href: termHref('menu', '') }, '+ New Session · open terminal picker'));
}
