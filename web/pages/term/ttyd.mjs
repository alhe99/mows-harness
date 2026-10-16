// ttyd.mjs — the ttyd 1.7.4 websocket client, nothing else (MAP 4.3, ledger D-08, K-22). No DOM at load, so scripts/term-proto-check.mjs drives it
// with a fake socket. Framing, exactly as ttyd's own page speaks it:
//   GET <base>/token -> {"token": ""}; ws <base>/ws + the page's ?arg= query, subprotocol "tty", binaryType arraybuffer.
//   up:   first frame after open is UTF-8 JSON with NO prefix byte {AuthToken, columns, rows}; then a one-character ASCII prefix:
//         '0' input · '1' resize (JSON {columns, rows}) · '2' pause · '3' resume.
//   down: '0' output (written to the terminal) · '1' title · '2' JSON preferences, applied through ALLOW below and nothing else.
// Flow control: after `limit` bytes written, one write callback is pending; more than `high` pending -> pause; fewer than `low` -> resume.
// Reconnect: close code 1000 -> "Press ⏎ to Reconnect" (Enter on the terminal); any other code -> a fresh token, then connect. After a
// socket ERROR (the link dropped: a laptop's VPN, a deploy) the page on screen retries by itself too, backing off BACKOFF.base * 2^n up to
// BACKOFF.max, so what is typed meanwhile is lost for a second, not until Enter (2026-10-12); a hidden page (a backgrounded phone) waits
// for kick(), which the foreground brings.

/** the only preferences the server may set; ttyd's other keys (rendererType, enableZmodem, ...) are ignored on purpose (D-08) */
export const ALLOW = ['fontSize', 'disableLeaveAlert', 'disableResizeOverlay', 'disableReconnect', 'titleFixed'];
export const FLOW = { limit: 1e5, high: 10, low: 4 };
export const BACKOFF = { base: 1000, max: 15000 };
const visible = () => globalThis.document?.visibilityState !== 'hidden';

/**
 * @param {{ term: any, base?: string, search?: string, WS?: any, host?: { protocol: string, host: string }, fetchImpl?: any,
 *           on?: { status?: (s: string) => void, title?: (t: string) => void, prefs?: (p: any) => void, socket?: (ev: string, ws: any, x?: any) => void } }} o
 */
export function ttydClient({ term, base = '/term', search = '', WS = globalThis.WebSocket, host = globalThis.location, fetchImpl = globalThis.fetch, on = {} }) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  /** @type {any} */ let socket = null, keyOff = null;
  let token = '', opened = false, doReconnect = true, reconnecting = false, written = 0, pending = 0, errs = 0;
  const say = s => on.status?.(s);

  const frame = (cmd, payload = '') => enc.encode(cmd + payload);
  const send = (/** @type {Uint8Array} */ f) => { if (socket && socket.readyState === 1) socket.send(f); };
  const refreshToken = () => fetchImpl(`${base}/token`).then(r => r.json()).then(j => { token = j.token || ''; }).catch(() => {});

  function write(/** @type {Uint8Array} */ data) {
    written += data.length;
    if (written > FLOW.limit) {
      term.write(data, () => { pending = Math.max(pending - 1, 0); if (pending < FLOW.low) send(frame('3')); });
      pending++; written = 0;
      if (pending > FLOW.high) send(frame('2'));
    } else term.write(data);
  }

  function prefs(/** @type {any} */ p) {
    const ok = {};
    for (const k of ALLOW) if (p && k in p) ok[k] = p[k];
    if (ok.disableReconnect) doReconnect = false;
    on.prefs?.(ok);
  }

  function connect() {
    reconnecting = false;
    const ws = socket = new WS(`${host.protocol === 'https:' ? 'wss:' : 'ws:'}//${host.host}${base}/ws${search}`, ['tty']);
    let errored = false;
    ws.binaryType = 'arraybuffer';
    on.socket?.('new', ws);
    ws.onopen = () => {
      if (socket !== ws) return;
      ws.send(enc.encode(JSON.stringify({ AuthToken: token, columns: term.cols, rows: term.rows })));
      if (opened) { term.reset(); say('Reconnected'); }
      opened = true; errs = 0;
      on.socket?.('open', ws);
    };
    ws.onmessage = ev => {
      if (socket !== ws) return;
      const buf = typeof ev.data === 'string' ? enc.encode(ev.data) : new Uint8Array(ev.data);
      on.socket?.('message', ws, buf.length);
      const body = buf.subarray(1);
      switch (String.fromCharCode(buf[0])) {
        case '0': write(body); break;
        case '1': on.title?.(dec.decode(body)); break;
        case '2': try { prefs(JSON.parse(dec.decode(body))); } catch { /* a malformed prefs frame changes nothing */ } break;
        default: console.warn('[ttyd] unknown message type', buf[0]);
      }
    };
    ws.onerror = () => { if (socket === ws) { errored = true; on.socket?.('error', ws); } };
    ws.onclose = ev => {
      if (socket !== ws) return;
      on.socket?.('close', ws, ev.code);
      say('Connection Closed');
      if (ev.code !== 1000 && doReconnect) {
        if (!errored) { say('Reconnecting...'); refreshToken().then(connect); return; }
        if (visible()) { const wait = Math.min(BACKOFF.max, BACKOFF.base * 2 ** Math.min(errs++, 8)); say('Reconnecting...'); setTimeout(() => { if (socket === ws) reconnect(); }, wait); return; }
      }
      keyOff?.dispose();
      keyOff = term.onKey((/** @type {any} */ e) => { if (e.domEvent.key === 'Enter') reconnect(); });
      say('Press ⏎ to Reconnect');
    };
  }

  /** a fresh token, then a new socket; one at a time */
  function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    keyOff?.dispose(); keyOff = null;
    say('Reconnecting...');
    refreshToken().then(connect);
  }

  term.onData(d => send(frame('0', d)));
  term.onBinary(d => { const f = new Uint8Array(d.length + 1); f[0] = 48; for (let i = 0; i < d.length; i++) f[i + 1] = d.charCodeAt(i) & 255; send(f); });
  term.onResize(({ cols, rows }) => send(frame('1', JSON.stringify({ columns: cols, rows }))));

  return {
    start: () => refreshToken().then(connect),
    reconnect,
    /** a dead socket (closed or closing) is reconnected now; a live or still-connecting one is left alone, so extra calls are free */
    kick: () => { if (socket && socket.readyState > 1) reconnect(); },
    get socket() { return socket; },
  };
}
