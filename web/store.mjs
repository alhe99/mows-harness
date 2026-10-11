// store.mjs — signals + the tab's one EventSource on /stream (K-13, K-14, K-17, K-34). Views read signals and never open a stream.
// The boot snapshot seeds the signals before the stream opens (K-07), so a first paint needs no round trip.
import { signal, batch } from '@preact/signals';

const RETRY_MIN = 1000, RETRY_MAX = 30000, HIDDEN_MS = 60000, CLOSED = 2;

/** @param {any} env  globalThis in the browser; scripts/store-check.mjs passes a fake EventSource, fetch, document and timers. */
export function createStore(env = globalThis) {
  const fleet = signal(/** @type {import('./contract').FleetItem[]} */ ([]));
  const agents = signal(/** @type {import('./contract').AgentItem[]} */ ([]));
  const chat = signal(/** @type {import('./contract').ChatDelta | null} */ (null));
  const chatend = signal(/** @type {import('./contract').ChatEnd | null} */ (null));
  const usage = signal(/** @type {import('./contract').UsageEvent | null} */ (null));
  const system = signal(/** @type {import('./contract').SystemEvent | null} */ (null));
  /** agent -> turn whose deltas are arriving and whose chatend has not. */
  const busy = signal(/** @type {Record<string, number>} */ ({}));
  /** agent -> turns refetched from /api/agents/<n>/chat after a reconnect. */
  const chatLog = signal(/** @type {Record<string, import('./contract').ApiAgentChat['turns']>} */ ({}));

  /** route (path + search) -> scroll offset, kept across route changes so Back and Forward restore it (K-35). */
  const scroll = new Map();
  /** url -> { t, p, v }: JSON a tab link's hover or touch fetched ahead of the tap (K-35), or the boot snapshot carried; one GET per url
   *  per 30 s, shared with the view that asks. `v` is the resolved value, so a view can render its first frame without waiting. */
  const jsonCache = new Map();
  const getJson = (url, force = false) => {
    const e = jsonCache.get(url);
    if (!force && e && Date.now() - e.t < 30000) return e.p;
    const p = env.fetch(url).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
    const ent = { t: Date.now(), p, v: undefined };
    jsonCache.set(url, ent);
    p.then(v => { ent.v = v; }, () => { if (jsonCache.get(url) === ent) jsonCache.delete(url); });
    return p;
  };
  const peek = url => { const e = jsonCache.get(url); return e && Date.now() - e.t < 30000 ? e.v : undefined; };
  /** Route to a shell URL without a document load: main.mjs registers its router here; until then (and in Node) it is a plain navigation. */
  let go = /** @type {(url: string) => void} */ (u => env.location.assign(u));
  const seed = (url, v) => { if (v) jsonCache.set(url, { t: Date.now(), p: Promise.resolve(v), v }); };

  let es = /** @type {any} */ (null), url = '', attempt = 0, retry = null, hiddenTimer = null, wasOpen = false, lastId = '', pending = false;
  /** topic -> watchers: the per-view topics (chat:<agent>) added to the one stream's base topics while a view needs them. */
  const extra = new Map();
  const streamUrl = () => url + [...extra.keys()].map(t => ',' + t).join('');
  const setBusy = (agent, turn) => { const b = { ...busy.value }; if (turn == null) delete b[agent]; else b[agent] = turn; busy.value = b; };

  function open() {
    if (es) return;
    env.clearTimeout(retry); retry = null;
    // A new EventSource sends no Last-Event-ID of its own (only the browser's built-in retry does), so a manual reopen carries it
    // in the query and the server replays the in-flight turn from there.
    es = new env.EventSource(lastId ? `${streamUrl()}&lastEventId=${encodeURIComponent(lastId)}` : streamUrl());
    const mine = es;
    const on = (name, fn) => mine.addEventListener(name, e => fn(JSON.parse(e.data), e));
    on('fleet', d => { fleet.value = d; });
    on('agents', d => { agents.value = d; });
    on('usage', d => { usage.value = d; });
    on('system', d => { system.value = d; });
    on('chat', (d, e) => { lastId = e.lastEventId || lastId; batch(() => { chat.value = d; if (busy.value[d.agent] !== d.turn) setBusy(d.agent, d.turn); }); });
    on('chatend', d => batch(() => { chatend.value = d; setBusy(d.agent); }));
    mine.addEventListener('open', () => {
      attempt = 0;
      if (wasOpen) resync();
      wasOpen = true;
    });
    mine.addEventListener('error', () => {
      if (mine !== es || mine.readyState !== CLOSED) return; // CONNECTING: the browser is already retrying by itself
      es = null;
      const wait = Math.min(RETRY_MAX, RETRY_MIN * 2 ** attempt * (0.8 + Math.random() * 0.4));
      attempt++;
      retry = env.setTimeout(() => { retry = null; open(); }, wait);
    });
  }

  function close() {
    env.clearTimeout(retry); retry = null;
    if (es) { es.close(); es = null; }
  }

  // A chatend is never replayed (no id: — K-14), so a reconnect can have skipped one. Every agent still marked busy is refetched;
  // the turn is over when its last recorded turn is the assistant's, and the view's busy state clears with it.
  function resync() {
    for (const agent of Object.keys(busy.value)) {
      env.fetch(`/api/agents/${encodeURIComponent(agent)}/chat`).then(r => r.json()).then(j => {
        const turns = (j && j.turns) || [];
        batch(() => {
          chatLog.value = { ...chatLog.value, [agent]: turns };
          if (turns.length && turns[turns.length - 1].role !== 'user') setBusy(agent);
        });
      }).catch(() => {});
    }
  }

  // A view that needs a topic the default four do not carry (the agent chat: chat:<name>) holds it with watch(); the stream is reopened
  // once per burst of changes, with the last chat id so the server replays the in-flight turn, and the returned function lets go.
  function watch(topic) {
    extra.set(topic, (extra.get(topic) || 0) + 1);
    const reopen = () => {
      if (pending || !url) return;
      pending = true;
      queueMicrotask(() => { pending = false; if (es) { es.close(); es = null; open(); } });
    };
    if (extra.get(topic) === 1) reopen();
    return () => { const n = (extra.get(topic) || 1) - 1; if (n) extra.set(topic, n); else { extra.delete(topic); reopen(); } };
  }

  function onVisibility() {
    if (env.document.visibilityState === 'hidden') {
      hiddenTimer = env.setTimeout(() => { hiddenTimer = null; close(); }, HIDDEN_MS);
    } else {
      env.clearTimeout(hiddenTimer); hiddenTimer = null;
      attempt = 0; open();
    }
  }

  /** @param {import('./contract').BootSnapshot} boot @param {{ topics?: string }} [opts] */
  function start(boot, { topics = 'fleet,agents,usage,system' } = {}) {
    batch(() => {
      if (boot.fleet) fleet.value = boot.fleet;
      if (boot.agents) agents.value = boot.agents;
      if (boot.system) { const { usage: u, ...s } = boot.system; system.value = s; if (u) usage.value = u; }
    });
    // the route's own JSON is in the boot snapshot (K-07): its first fetch is answered from here, under the key the view asks with
    const q = env.location?.search || '';
    seed('/api/history' + q, boot.history); seed('/api/system' + q, boot.system); seed('/api/device' + q, boot.device);
    if (boot.session) seed(`/api/session/${boot.session.a}/${boot.session.sid}` + q, boot.session);
    url = `/stream?topics=${topics}`;
    env.document.addEventListener('visibilitychange', onVisibility);
    open();
  }

  return { fleet, agents, chat, chatend, usage, system, busy, chatLog, scroll, getJson, peek, go: u => go(u), setGo: f => { go = f; }, watch, start, stop: () => { env.document.removeEventListener('visibilitychange', onVisibility); env.clearTimeout(hiddenTimer); close(); } };
}

export const store = createStore();
