import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, usd } from '../ui.mjs';
import { getJSON, connect, subscribe } from '../store.mjs';
import { marked } from 'marked';

// A trailing unterminated fence is the classic streaming-markdown failure: the rest of the reply
// renders as prose with stray backticks. Close it for DISPLAY only; the buffer is untouched.
// Exported so scripts/chat-view-check.mjs exercises THIS function and not a copy of it — the
// same reason Task 6 pulled wireChatStream() out of lite.mjs into its own module.
export function renderPartial(text) {
  const fences = (text.match(/```/g) || []).length;
  return marked.parse(fences % 2 ? text + '\n```' : text, { async: false });
}

export function Chat({ name, runs }) {
  const [turns, setTurns] = useState([]);
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const boxRef = useRef(null), taRef = useRef(null), turnRef = useRef(0);
  const chatable = (runs || []).some(r => r.state === 'done');

  useEffect(() => {
    getJSON(`/api/agents/${name}/chat`).then(d => setTurns(d.turns)).catch(() => {});
    connect(['agents', `chat:${name}`]);
    const offA = subscribe('chat', d => {
      if (d.agent !== name) return;
      // A delta from a newer turn replaces the buffer rather than appending to it. This is
      // the same reset-on-mismatch rule the server's chatBuf uses, and it is what makes
      // turnRef current before any `chatend` is compared against it.
      if (d.turn !== turnRef.current) { turnRef.current = d.turn; setLive(''); }
      setBusy(true); setLive(s => s + d.delta);
    });
    const offB = subscribe('chatend', d => {
      if (d.agent !== name) return;
      // The server is first-end-wins; the client is newest-turn-wins. Both are needed. When a
      // turn's child dies, the server sends a `closed:true` fallback for THAT turn, which can
      // arrive after a newer turn has already started streaming — clearing `live`
      // unconditionally would wipe the in-flight reply the user is watching (Task 6 review, R3).
      if (d.turn && d.turn < turnRef.current) return;
      setBusy(false); setLive('');
      getJSON(`/api/agents/${name}/chat`).then(x => setTurns(x.turns)).catch(() => {});
    });
    return () => { offA(); offB(); };
  }, [name]);

  // Safari implements no CSS scroll-anchoring, so this is hand-written on purpose (spec §4).
  // A CSS-only approach would be correct on desktop and wrong on the phone this is built for.
  const onScroll = useCallback(() => {
    const el = boxRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);
  useEffect(() => {
    if (atBottom && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [turns, live, atBottom]);

  // Keep the composer above the on-screen keyboard. 100vh does not account for it.
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const fit = () => document.documentElement.style.setProperty('--kb', (window.innerHeight - vv.height - vv.offsetTop) + 'px');
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
  }, []);

  const send = async e => {
    e.preventDefault();
    const msg = taRef.current.value.trim(); if (!msg) return;
    taRef.current.value = '';
    setTurns(t => [...t, { at: new Date().toISOString(), role: 'user', text: msg }]);
    setBusy(true); setAtBottom(true);
    const body = new URLSearchParams({ name, back: `/ui/agents/${name}`, msg });
    await fetch('/a/agent-chat', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  };

  if (!chatable) return html`<p class="muted">Chat resumes a finished run's session. Run this agent once first.</p>`;
  return html`<div class="chat">
    <div class="chatbox" ref=${boxRef} onScroll=${onScroll}>
      ${turns.map((t, i) => html`<div class="m ${t.role === 'user' ? 'me' : 'claude'}" key=${i}>
        <div class="mh"><b>${t.role === 'user' ? 'you' : name}</b>
          <span class="muted">${(t.at || '').slice(11, 19)}${t.cost_usd ? ' · ' + usd(t.cost_usd) : ''}</span></div>
        <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(t.text || '') }} /></div>`)}
      ${live && html`<div class="m claude streaming">
        <div class="mh"><b>${name}</b> <span class="muted">…</span></div>
        <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(live) }} /></div>`}
      ${busy && !live && html`<p class="muted">Thinking…</p>`}
    </div>
    ${!atBottom && html`<button class="jump" onClick=${() => setAtBottom(true)}>Jump to latest</button>`}
    <form class="chatf" onSubmit=${send}>
      <textarea ref=${taRef} rows="2" placeholder=${`Ask ${name} about its last run…`}
        onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); }} required></textarea>
      <button disabled=${busy}>${busy ? '…' : 'Send'}</button>
    </form>
  </div>`;
}
