// keys.mjs — the Device view's "Remote keys" card, loaded only when the QA browser is live (its own chunk, so the Device route stays small).
// The buttons press keys on the noVNC session inside the stage's iframe.
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { Icon } from './shared.mjs';

// the glyphs this card draws (legacy ICO path data)
const iArrowLeft = '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>';
const iChevronDown = '<path d="M6 9l6 6 6-6"/>';
const iChevronUp = '<path d="M18 15l-6-6-6 6"/>';
const iClipboard = '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/>';
const iKeyboard = '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 14h12M6 10h.01M10 10h.01M14 10h.01M18 10h.01"/>';
const iSquare = '<rect x="5" y="5" width="14" height="14" rx="2"/>';
const iRefresh = '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>';
const btn = (cls, title, d, onClick) => h('button', { class: 'ctlbtn ' + cls, type: 'button', title, 'aria-label': title, onClick }, h(Icon, { d }));

// the legacy remote-keys script, on the iframe's own RFB session: noVNC does not expose it, so a module that re-imports ui.js in the
// same-origin frame (ES-module singleton -> the same UI.rfb) is injected until `window.rfb` exists
function useRfb(frame, on) {
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      try {
        const f = frame.current;
        if (!f || f.contentWindow.rfb) return;
        const s = f.contentDocument.createElement('script');
        s.type = 'module'; s.textContent = "import UI from './app/ui.js';window.rfb=UI.rfb;";
        f.contentDocument.body.appendChild(s);
      } catch { /* the frame is not loaded yet */ }
    }, 1200);
    return () => clearInterval(t);
  }, [on]);
  const rfb = () => frame.current?.contentWindow?.rfb;
  const k = (sym, code) => rfb()?.sendKey(sym, code);
  return {
    k,
    kb: () => { try { const d = frame.current.contentDocument; d.getElementById('noVNC_keyboard_button').click(); d.getElementById('noVNC_keyboardinput')?.focus(); } catch { /* not ready */ } },
    nav: back => { // Alt+Left / Alt+Right
      const r = rfb(), s = back ? 0xff51 : 0xff53, c = back ? 'ArrowLeft' : 'ArrowRight';
      if (!r) return;
      r.sendKey(0xffe9, 'AltLeft', true); r.sendKey(s, c, true); r.sendKey(s, c, false); r.sendKey(0xffe9, 'AltLeft', false);
    },
    // device clipboard -> remote clipboard -> Ctrl+V into the focused remote field
    paste: async () => {
      const r = rfb();
      if (!r) return;
      const put = t => { r.clipboardPasteFrom(t); setTimeout(() => { r.sendKey(0xffe3, 'ControlLeft', true); r.sendKey(0x76, 'KeyV', true); r.sendKey(0x76, 'KeyV', false); r.sendKey(0xffe3, 'ControlLeft', false); }, 90); };
      const t = await navigator.clipboard?.readText().catch(() => '');
      const m = t || prompt('Paste text here, then OK — I will type it into the browser:');
      if (m) put(m);
    },
  };
}

export default function RemoteKeys({ frame, on }) {
  const keys = useRfb(frame, on);
  return h('div', { class: 'devcard' }, h('div', { class: 'ctlhead' }, 'Remote keys'), h('div', { class: 'ctlgrid icons4' },
    btn('', 'show keyboard', iKeyboard, keys.kb), btn('', 'paste clipboard', iClipboard, keys.paste),
    btn('', 'scroll up', iChevronUp, () => keys.k(0xff55, 'PageUp')), btn('', 'scroll down', iChevronDown, () => keys.k(0xff56, 'PageDown')),
    btn('', 'back', iArrowLeft, () => keys.nav(1)), btn('icoflip', 'forward', iArrowLeft, () => keys.nav(0)),
    btn('', 'reload', iRefresh, () => keys.k(0xffc2, 'F5')), btn('', 'escape', iSquare, () => keys.k(0xff1b, 'Escape'))));
}
