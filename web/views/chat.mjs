// chat.mjs — the agent chat card: transcript, live reply, optimistic send, scroll anchoring and the composer. Ported from the /ui
// app's views/chat.mjs with its behaviour unchanged; what moved is where the data comes from. The tab's one stream is the store's
// (K-13): deltas and ends arrive on signals (the agent view holds chat:<name> on it while mounted), and a reconnect that skipped a
// `chatend` is answered by the store's refetch (store.chatLog, K-34). Markdown is md.mjs, imported lazily so marked is its own chunk.
// reconcile() and renderPartial() live in md.mjs, where scripts/chat-view-check.mjs exercises them.
import { h } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { store } from '../store.mjs';
import { usd, base, getJSON } from '../ui.mjs';

// events.log lines are "<ISO8601> <text>". Only some of them earn a divider in the transcript: the log records one line per chat
// turn ("chat turn (streamed): $0.02"), and that cost is already printed on the message it belongs to, so rendering all of them
// would interrupt every single message with a restatement of itself. What survives the filter is the run lifecycle and the
// failures, and a memory that was cut or cleared — which is what the comp's one divider is for.
const EV_RE = /^(\d{4}-\d\d-\d\dT[\d:]+(?:[+-][\d:]+|Z))\s+(.+)$/;
const systemEvents = events => (events || [])
  .map(l => EV_RE.exec(l))
  // `memory stored` is per-turn too — the reply above it carries the same fact as a pill — so it joins the filter.
  // `memory truncated` and `memory cleared` stay: those are worth a line.
  .filter(m => m && !/^(chat turn|memory stored)\b/.test(m[2]))
  .map(m => ({ at: m[1], text: m[2] }));

// Turns keep the ORDER THE SERVER GAVE THEM — they are not re-sorted. Sorting a merged list by timestamp would put the reconcile
// logic's optimistic pendings (stamped client-side, at a clock this server does not share) at the mercy of clock skew, and message
// order is the one thing this view has already been fixed twice to get right. System events are interleaved around that fixed
// order instead: each one is emitted before the first turn it does not precede.
function feed(turns, events) {
  const left = systemEvents(events);
  const out = [];
  for (const turn of turns) {
    const ts = Date.parse(turn.at || 0);
    while (left.length && Date.parse(left[0].at) <= ts) out.push({ sys: left.shift() });
    out.push({ turn });
  }
  for (const sys of left) out.push({ sys });
  return out;
}

// md.mjs holds marked: loaded on first use, and awaited by the handlers that need reconcile() (which is in it, for the gate)
let MD = null;
const loadMd = () => import('../md.mjs').then(m => (MD = m));

const body = (md, text, open) => h('div', { class: 'mb', dangerouslySetInnerHTML: { __html: md ? md.renderBlocks(text, open) : '' } });

/** @param {{ name: string, events?: string[], tools?: string | null }} props */
export function Chat({ name, events, tools }) {
  const [turns, setTurns] = useState(/** @type {any[]} */ ([]));
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(() => store.busy.peek()[name] != null);
  const [err, setErr] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [md, setMd] = useState(/** @type {any} */ (null));
  const boxRef = useRef(/** @type {any} */ (null)), taRef = useRef(/** @type {any} */ (null)), turnRef = useRef(0), liveRef = useRef('');
  // Messages this client has shown and has not yet seen come back in a refetched transcript. A ref and not state: the handlers
  // below are created once per `name` and would otherwise close over the first render's value, which is the bug that makes an
  // optimistic bubble look preserved in testing and vanish in production.
  const pendingRef = useRef(/** @type {any[]} */ ([]));

  useEffect(() => { loadMd().then(setMd); }, []);

  // A layout effect: it runs in the commit that inserts .chatbox, so no delta can arrive between the card being on screen and the
  // handlers being in place. (The stream carries chat:<name> from the moment the agent view mounts: agent.mjs holds the topic.)
  useLayoutEffect(() => {
    // Pendings belong to the agent they were typed at (review F2): never leak one agent's lost message into another's transcript.
    pendingRef.current = [];
    getJSON(`/api/agents/${name}/chat`).then(d => setTurns(d.turns)).catch(() => {});

    // The refetched transcript replaces what is on screen, so everything the client added optimistically and the transcript does
    // not have must be put back (reconcile), and the operator told. Shared by a `chatend` and by the store's reconnect refetch.
    const settleWith = async (list, endedTurn, salvage) => {
      const { reconcile } = MD || await loadMd();
      // The reply is only safe to stop showing once it is actually IN the transcript that came back. A refetch can SUCCEED and
      // still not contain it: a child killed before mows-agent's own append to chat.jsonl leaves exactly that state — transcript
      // fetched fine, finished turn missing — and the happy path is safe only because cmd_chat appends the assistant record BEFORE
      // printing the end line, a guarantee in a different program (review M1).
      //
      // newest-turn-wins still governs the REPLY (F8/R3) — so a stale end salvages nothing. It must NOT govern the user's own
      // message: that belongs to whoever typed it, and discarding it because an older turn ended is the very deletion being fixed.
      const mine = turnRef.current === endedTurn;
      const r = reconcile(list, pendingRef.current, mine ? salvage : '');
      setTurns(r.turns);
      // Anything still missing is now marked reported, so the next turn shows it neither again nor silently.
      pendingRef.current = r.missingUsers.map(q => ({ ...q, reported: true }));
      if (r.missingUsers.length) {
        // Hand the text back as well as saying so. Only when the composer is empty and only when no reply arrived at all — after a
        // real reply a retry would be a duplicate question, not a recovery.
        const lost = r.missingUsers[r.missingUsers.length - 1];
        const handedBack = !salvage && taRef.current && !taRef.current.value;
        if (handedBack) taRef.current.value = String(lost && lost.text || '');
        // The sentence has to match what actually happens next: the message is shown until the transcript next reloads, and then it is gone.
        setErr('Your message was not saved — the turn ended before the agent recorded it, so it probably never ran. It is shown below until the transcript reloads' +
          (handedBack ? '; the text is back in the composer.' : ' — copy it before sending anything else.'));
      } else if (r.salvagedReply) {
        setErr('Reply shown above, but it is not in the saved transcript yet.');
      }
      clear(endedTurn);
    };
    // `live` is held until the refetched transcript is actually in hand (fix round 1): clearing it first left the finished reply on
    // screen NOWHERE for one round trip. Only the turn that ended may clear the buffer.
    const clear = ended => { if (turnRef.current === ended) { liveRef.current = ''; setLive(''); } };

    // The effects below run once on creation with whatever the signal holds; `ready` skips that stale first run.
    let ready = false;
    const offDelta = effect(() => {
      const d = store.chat.value;
      if (!ready || !d || d.agent !== name) return;
      // A delta from a newer turn replaces the buffer rather than appending to it — the server's chatBuf rule, and what makes
      // turnRef current before any `chatend` is compared against it.
      if (d.turn !== turnRef.current) { turnRef.current = d.turn; liveRef.current = ''; }
      // liveRef mirrors `live` so the end handler can salvage the finished reply without reading it back out of a state updater.
      liveRef.current += d.delta;
      setBusy(true); setErr(''); setLive(liveRef.current);
    });
    const offEnd = effect(() => {
      const d = store.chatend.value;
      if (!ready || !d || d.agent !== name) return;
      // The server is first-end-wins; the client is newest-turn-wins. When a turn's child dies the server sends a `closed:true`
      // fallback for THAT turn, which can arrive after a newer turn has started streaming — clearing `live` unconditionally
      // would wipe the in-flight reply the user is watching (Task 6 review, R3).
      if (d.turn && d.turn < turnRef.current) return;
      setBusy(false);
      // d.turn, not turnRef.current: turnRef is the turn the client last saw a DELTA for, which differs from the turn that ended
      // whenever an end arrives for a turn that produced none (review L2).
      const endedTurn = d.turn || turnRef.current, salvage = liveRef.current;
      getJSON(`/api/agents/${name}/chat`)
        .then(x => settleWith(x.turns || [], endedTurn, salvage))
        .catch(() => {
          // The refetch failed outright, so NOTHING can be concluded about what was saved. Settle what is on screen rather than
          // blanking it, and leave every pending PENDING: a failed fetch is not evidence that a message is missing, nor present.
          // Hence `[]` here — only the reply is salvaged.
          if (turnRef.current === endedTurn && salvage && MD) setTurns(t => MD.reconcile(t, [], salvage).turns);
          clear(endedTurn);
          // Say only what is known (review F11).
          setErr(salvage
            ? 'Reply received, but reloading the transcript failed. Reload to confirm it was saved.'
            : 'The turn ended and reloading the transcript failed, so this view may be out of date. Reload to see what was saved.');
        });
    });
    // The chatend-gap case (K-34, ledger D-04): a turn that ended while the stream was cut is never replayed. On reconnect the
    // store refetches the transcript of every agent still marked busy and publishes it here; when its last turn is the agent's the
    // turn is over, and it settles exactly as an end that had arrived.
    let seen = store.chatLog.peek()[name];
    const offLog = effect(() => {
      const list = store.chatLog.value[name];
      if (!ready || !list || list === seen) return;
      seen = list;
      if (list.length && list[list.length - 1].role === 'user') return;
      setBusy(false);
      settleWith(list, turnRef.current, liveRef.current);
    });
    ready = true;
    return () => { offDelta(); offEnd(); offLog(); };
  }, [name]);

  // Safari implements no CSS scroll-anchoring, so this is hand-written on purpose (spec §4). A CSS-only approach would be correct on
  // desktop and wrong on the phone this is built for. Within 40 px of the bottom counts as at the bottom.
  const onScroll = () => {
    const el = boxRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  useEffect(() => {
    if (atBottom && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [turns, live, atBottom, md]);

  // Keep the composer above the on-screen keyboard. 100vh does not account for it. (kb-open is set from the composer's focus/blur
  // below, not from here: in the installed PWA iOS pans the page for the keyboard instead of resizing the visual viewport, so this
  // handler measures 0 there and a viewport-based flag never fired.)
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const fit = () => document.documentElement.style.setProperty('--kb', (window.innerHeight - vv.height - vv.offsetTop) + 'px');
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    return () => {
      vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit);
      document.documentElement.classList.remove('kb-open'); // unmounting mid-focus must not leave the bar hidden
    };
  }, []);

  const send = async e => {
    e.preventDefault();
    const msg = taRef.current.value.trim(); if (!msg) return;
    taRef.current.value = '';
    // How many TRANSCRIPT-BACKED user turns already carry this exact text. Our own optimistic copies are subtracted: they sit in
    // `turns` and are not in the transcript, and counting them would raise the bar so far that a genuinely saved message read as
    // lost. reconcile treats the message as saved only once the refetched count exceeds this, which is what makes a REPEATED
    // question distinguishable from the earlier one that was saved (review F1).
    const sameText = t => t && t.role === 'user' && String(t.text ?? '') === msg;
    const baseline = turns.filter(sameText).length - pendingRef.current.filter(sameText).length;
    // Kept by reference so the optimistic bubble can be withdrawn again if the POST never lands.
    const pending = { at: new Date().toISOString(), role: 'user', text: msg, baseline: Math.max(0, baseline) };
    // Also recorded OUTSIDE the turns list, so the refetch that replaces that list wholesale can be asked whether it contains it.
    pendingRef.current = [...pendingRef.current, pending];
    setTurns(t => [...t, pending]);
    setBusy(true); setErr(''); setAtBottom(true);
    const form = new URLSearchParams({ name, back: `${base()}/agents/${name}`, msg });
    try {
      const r = await fetch('/a/agent-chat', { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      // A non-2xx is as fatal as a thrown fetch: agentAction answers 400 on an empty message, 403 on a bad origin and 409 when the
      // agent unit is not installed, and every one of them used to wedge the composer.
      if (!r.ok) throw new Error((await r.text().catch(() => '')).trim().slice(0, 160) || `HTTP ${r.status}`);
    } catch (ex) {
      // No turn started, so no `chatend` is coming to clear `busy`. The typed text goes back in the box rather than being lost with it.
      setBusy(false);
      pendingRef.current = pendingRef.current.filter(x => x !== pending);
      setTurns(t => t.filter(x => x !== pending));
      setErr(`Could not send: ${/** @type {any} */ (ex).message || ex}`);
      if (!taRef.current.value) taRef.current.value = msg;
    }
  };

  // No completed-run gate (spec 2026-09-19 §2.4): a chat turn no longer resumes a session, so there is nothing a first run has to
  // create before the first question can be asked.
  return h('div', { class: 'chat' },
    h('div', { class: 'chatbox', ref: boxRef, onScroll },
      feed(turns, events).map((row, i) => row.sys
        ? h('div', { class: 'sysdiv', key: 's' + i }, h('span', { class: 'sysl' }),
          h('span', { class: 'sysb' }, h('i', { class: 'sysi', 'aria-hidden': 'true' }), row.sys.text,
            h('span', { class: 'muted' }, row.sys.at.slice(11, 19))),
          h('span', { class: 'sysl' }))
        : h('div', { class: `m ${row.turn.role === 'user' ? 'me' : 'claude'}`, key: i },
          h('span', { class: 'mav', 'aria-hidden': 'true' }),
          h('div', { class: 'mc' },
            h('div', { class: 'mh' }, h('b', null, row.turn.role === 'user' ? 'you' : name),
              h('span', { class: 'muted' }, (row.turn.at || '').slice(11, 19), row.turn.cost_usd ? ' · ' + usd(row.turn.cost_usd) : '')),
            body(md, row.turn.text || '', false)))),
      live && h('div', { class: 'm claude streaming' },
        h('span', { class: 'mav', 'aria-hidden': 'true' }),
        h('div', { class: 'mc' },
          h('div', { class: 'mh' }, h('b', null, name), ' ', h('span', { class: 'muted' }, '…')),
          body(md, live, true))),
      busy && !live && h('p', { class: 'muted' }, 'Thinking…')),
    !atBottom && h('button', { class: 'jump', onClick: () => setAtBottom(true) }, 'Jump to latest'),
    err && h('p', { class: 'cherr', role: 'alert' }, err),
    h('form', { class: 'chatf', onSubmit: send },
      // A phone-width placeholder that wraps to two lines makes the composer look mid-edit. Read once at render; a resize across
      // 500px mid-conversation is not a case worth a listener.
      // Focus is the keyboard signal iOS reports everywhere (the installed PWA pans the page for the keyboard instead of resizing
      // the visual viewport). html.kb-open hides the phone tab bar while set; a class, not a style, for CSP. Cleared on blur —
      // Done, a tap elsewhere, or Send, which moves focus to the button.
      h('textarea', { ref: taRef, rows: 2, required: true,
        placeholder: matchMedia('(max-width: 500px)').matches ? `Ask ${name}…` : `Ask ${name} to analyze or run commands…`,
        onFocus: () => document.documentElement.classList.add('kb-open'),
        onBlur: () => document.documentElement.classList.remove('kb-open'),
        onKeyDown: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) send(e); } }),
      // The label is an aria-label, not a text node: the comp's send control is a 40px circle and "Send" does not fit in one. The
      // busy state keeps a visible "…" because a disabled control with no text and no icon looks like a rendering failure.
      h('button', { class: 'sendb', disabled: busy, 'aria-label': busy ? 'Sending' : 'Send' }, busy ? '…' : '')),
    tools && h('p', { class: 'chint' }, name, ' has access to ', tools, '.', h('span', { class: 'chint-help' }, ' Use /help for commands.')));
}
