// Client state. One EventSource for the whole tab (spec §3, D4) — views subscribe to topics
// rather than opening their own connection.
let es = null, wanted = new Set();
const subs = new Map(); // event name -> Set<fn>
export const state = { agents: [], agent: null, chat: [], streaming: null };
export function subscribe(ev, fn) {
  if (!subs.has(ev)) subs.set(ev, new Set());
  subs.get(ev).add(fn);
  return () => subs.get(ev).delete(fn);
}
function emit(ev, data) { for (const fn of subs.get(ev) || []) fn(data); }
export function connect(topics) {
  const next = new Set(topics);
  if (es && [...next].every(t => wanted.has(t)) && [...wanted].every(t => next.has(t))) return;
  wanted = next;
  if (es) es.close();
  // EventSource reconnects on its own and resends Last-Event-ID (spec D7) — do not hand-roll it.
  es = new EventSource(`/stream?topics=${[...wanted].join(',')}`);
  for (const ev of ['fleet', 'agents', 'chat', 'chatend']) {
    es.addEventListener(ev, e => { try { emit(ev, JSON.parse(e.data)); } catch {} });
  }
}
export async function getJSON(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
