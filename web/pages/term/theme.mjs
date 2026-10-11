// theme.mjs — terminal themes (MAP 4.4, ledger B-01, K-12). The colours are CSS: build.mjs generates one [data-theme="<Name>"] block per theme
// from infra/webconsole/themes.json (the single source) and term.css holds the default on :root, all as --t-<key> custom properties. This
// module only picks a name and reads the 20 properties back into term.options.theme, the body background and <meta name=theme-color>.
// Precedence: localStorage.cctheme -> the global /settings/term-theme.json (polled every 30 s) -> the default. ?theme=<Name> saves one
// (an unknown name such as "default" clears it), ?theme=off turns the picker and the theming off, window.cctheme(name) does the same by hand.
import NAMES from 'themes:names';
import { el, param, store } from './dom.mjs';

const KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite', 'background', 'foreground', 'cursor', 'selectionBackground'];
const KEY = 'cctheme';

export function themes(/** @type {import('@xterm/xterm').Terminal} */ term) {
  if (param('theme') === 'off') return { select: null };
  const q = param('theme');
  let globalName = '';
  const known = n => NAMES.includes(n);
  const effective = () => (known(store.get(KEY)) ? store.get(KEY) : known(globalName) ? globalName : '');
  const save = n => store.set(KEY, known(n) ? n : '');
  const select = el('select', { id: 'ccthemesel', title: 'terminal theme' }, el('option', { value: 'Default', textContent: 'Auto (global)' }),
    ...NAMES.map(n => el('option', { value: n, textContent: n })));

  function apply() {
    const n = effective(), root = document.documentElement;
    n ? root.dataset.theme = n : delete root.dataset.theme;
    const cs = getComputedStyle(root), t = {};
    for (const k of KEYS) t[k] = cs.getPropertyValue('--t-' + k).trim();
    if (t.selectionBackground.length === 7) t.selectionBackground += '80'; // the ports assume Windows Terminal's 50 % selection alpha
    term.options.theme = t;
    document.body.style.background = t.background; // the safe-area edges around the terminal
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.background);
    select.value = known(store.get(KEY)) ? store.get(KEY) : 'Default';
    return n;
  }
  const poll = () => fetch('/settings/term-theme.json').then(r => (r.ok ? r.json() : null)).then(d => {
    if (d && typeof d.name === 'string' && d.name !== globalName) { globalName = d.name; apply(); }
  }).catch(() => {});

  if (q) save(q);
  select.addEventListener('change', () => { save(select.value); apply(); });
  /** @type {any} */ (window).cctheme = n => { save(n); apply(); return NAMES; };
  apply(); poll(); setInterval(poll, 30000);
  return { select, apply };
}
