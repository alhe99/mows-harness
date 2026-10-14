// web/contract.d.ts — the one file Builders and Verifiers both import.
// A change here is a reviewable diff (ARCHITECTURE.md §11). Shapes below are the ones lite.mjs
// emits today (MAP.md §1.2, §3.3, §3.4) plus the additive topics and endpoints the ledger kept
// (K-13, K-37). Field names are verbatim; do not "tidy" them.

// ---- SSE: GET /stream?topics=fleet,agents,chat:<agent>,usage,system -------------------------

export type FleetState = 'needs-you' | 'working' | 'paused' | 'idle';

export interface FleetItem {
  sid8: string;            // fleetKey: f.sid8 || f.name
  name: string;            // tmux session name
  label: string;           // ccname label, '' if none
  proj: string;            // project basename
  state: FleetState;
  rel: number;             // mtime, ms epoch (client renders relative time)
  snippet: string;         // last pane text, <=160 chars
  kind: 'claude' | 'service'; // service = a tmux session with no claude process (servers an agent parked there)
  wins: { n: string; up: boolean }[]; // tmux windows in order; up = a process runs under its shell
  closeAt: number;         // service only: ms epoch it auto-closes at (nothing running for 10m), 0 = not closing
  born: number;            // tmux session_created, ms epoch: the grid sidebar's order (oldest first)
}

export type AgentRunState = 'working' | 'done' | 'failed' | 'stalled' | 'budget_exceeded' | 'never';

export interface AgentItem {
  name: string;
  state: AgentRunState;
  last_event_at: string | null;   // ISO
  total: number;                  // runs on disk
  cost7d: number;                 // USD
}

export interface ChatDelta { agent: string; turn: number; seq: number; delta: string }
export interface ChatEnd   { agent: string; turn: number; cost_usd?: number; is_error?: boolean; closed?: true }

// additive topics (K-13) — shapes copied from the /system panel's server helpers (MAP.md §1.3)
export interface UsageAcct { id: string; label: string; today: number; week: number; month: number;
                             block: { cost: number; rate: number } | null; tokExp: number | null }
export interface UsageEvent {
  quota: Record<string, { h5: number | null; wk: number | null }>;   // null = claude-quota printed "?" (token expired, tool absent)
  thr: number;
  accts: Record<string, UsageAcct>;
}
export interface SystemEvent {
  load: number; cores: number; memUsed: number; memTot: number; swapUsed: number; swapTot: number;
  dskUsed: number; dskTot: number; up: number; version: string | null;
}

export type StreamEvent =
  | { event: 'fleet';   data: FleetItem[] }                 // no id:
  | { event: 'agents';  data: AgentItem[] }                 // no id:
  | { event: 'chat';    data: ChatDelta; id: `${string}:${number}:${number}` }  // the only id: (K-14)
  | { event: 'chatend'; data: ChatEnd }                     // no id:
  | { event: 'usage';   data: UsageEvent }                  // no id:
  | { event: 'system';  data: SystemEvent };                // no id:

export const STREAM_MAX_CLIENTS = 16;       // raised from 8 (K-17); /events keeps 8
export const STREAM_HEARTBEAT_MS = 25_000;  // ': hb' comment (ledger D-06)
export const STREAM_TICK_MS = 2_000;

// ---- JSON API (GET unless stated) -------------------------------------------------------------

export interface ApiAgents { agents: AgentItem[] }
export interface ApiAgent {
  name: string;
  recs: Array<Record<string, unknown> & { run_id: string; state: AgentRunState }>;  // status.json fields, newest first, <=20
  events: string[];                 // last 5 lines of events.log
  total: number; cost7d: number;
  timers: Array<{ unit: string; masked: boolean; next: string | null }>;
  timer: { state: 'none' | 'paused' | 'active' | 'mixed'; label: string };
  capability: Record<string, unknown> | null;   // agentCapability() output; rendered by the capability view
  memory: string | null;
}
export interface ApiAgentChat { turns: Array<{ at: string; role: 'user' | 'assistant'; text: string; cost_usd?: number }> }
export interface ApiAgentRun  { status: Record<string, unknown>; text: string }

// boot snapshot inlined in the shell HTML (K-07): <script type="application/json" id="boot">
export interface BootSnapshot {
  route: string;
  fleet: FleetItem[];
  live: number;                     // for the Sessions badge
  indexed: number;                  // footer "N indexed"
  host: string;
  agents?: AgentItem[];             // when route starts with /agents
  history?: HistoryPage;            // when route is /history
  system?: ApiSystem;               // when route is /system
  device?: ApiDevice;               // when route is /device
  session?: ApiSession | null;      // when route is /s/<acct>/<sid>; null when the session is unknown
}

export interface HistoryRow {
  a: string; sid: string; sid8: string; proj: string; mt: number; sz: number;
  title: string | null; live: boolean; canResume: boolean; acctColor: string;
}
export interface HistoryPage { rows: HistoryRow[]; page: number; pages: number; total: number;
                               accts: Array<{ id: string; label: string; color: string; n: number; term: boolean }>;   // term: the account has the terminal (attach/resume)
                               resumeDays: number; // a transcript idle longer than this is not offered for resume (a live one always is)
                               live: number;       // live sessions, the `live` chip's count
                               indexed: number;    // sessions on disk before any filter, the `all` chip's count
                               acct: string;       // the account filter in force: ?acct=, else the host subdomain's account, else ''
                               label: string }     // the subdomain when it names an account (the h1's last word), else ''

// GET /api/history?acct&q&d&s&page -> HistoryPage; GET /api/system[?reclaim=1] -> ApiSystem; GET /api/device[?dv=mobile|web] -> ApiDevice;
// GET /api/session/<acct>/<sid>[?page=] -> ApiSession (404 when unknown); POST /api/usage/refresh -> 202 { ok: true }
export interface UsageAcctFull extends UsageAcct {
  qkey: string; cc: boolean;                                   // claude-quota's name for the account; whether ccusage answered at all
  models: Array<{ name: string; cost: number }>;               // today's spend by model, dearest first
  days: Array<{ d: string; cost: number; models: string[] }>;  // last 7 days, newest first
  sess: Array<{ sid: string; cost: number; models: string[] }>; // dearest sessions of the week, <=6
}
export interface ReclaimTarget { id: string; label: string; note: string; g: string; b: number; extra: string }  // g '' = safe, pre-checked
export interface ApiSystem extends SystemEvent {
  usage: (Omit<UsageEvent, 'accts'> & { accts: Record<string, UsageAcctFull> }) | null;   // null until the first collection lands
  now: number;                      // the server's clock, ms epoch: ages are read against it, not the viewer's
  usageAt: number;                  // ms epoch of the last collection, 0 before the first
  busy: boolean;                    // a collection is running: re-poll until it lands
  live: number;                     // live terminal sessions (the Restart All count)
  deployed: number | null;          // mtime of lite.mjs, ms epoch
  node: string; platform: string;
  reclaim?: ReclaimTarget[];        // only with ?reclaim=1
}
export interface ApiDevice {
  dv: 'mobile' | 'web';             // the segment to show: ?dv=, else whichever device is doing something
  droid: { state: 'stopped' | 'booting' | 'live'; res: string; udid: string };
  web: { live: boolean; port: number };
}
export interface ApiSessionMsg { role: 'user' | 'claude' | 'tool' | 'res' | 'sum'; ts: string; text: string; name?: string }
export interface ApiSession {
  a: string; sid: string; sid8: string;
  acct: { label: string; color: string; term: boolean };
  proj: string; started: string; mt: number; sz: number;
  items: number; tools: number; model: string; truncated: boolean;   // truncated: only the newest 8 MB window was read
  live: { name: string; paused: boolean; label: string } | null;
  canResume: boolean; resumeDays: number;
  page: number; pages: number;      // page 1 is the newest 25 items
  msgs: ApiSessionMsg[];            // chronological within the page
}

// actions stay POST + 303 (PRG); the shell submits them with fetch and falls back to a plain form
export type ActionRoute =
  | '/a/pause' | '/a/resume' | '/a/label' | '/a/kill' | '/a/del' | '/a/restartall' | '/a/switch'
  | '/a/agent-chat' | '/a/agent-run' | '/a/agent-pause' | '/a/agent-resume' | '/a/agent-stop'
  | '/droid/start' | '/droid/stop' | '/watch/start' | '/watch/stop' | '/sys/reclaim' | '/settings/term-theme';

// ---- push (K-37) ------------------------------------------------------------------------------

export interface ApiPushKey { key: string }                 // VAPID public key, base64url, GET /api/push/key
export interface PushSubscribeBody {                        // POST /api/push/subscribe (same-origin guarded)
  endpoint: string; expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}
export interface PushSubscribeReply { ok: true; id: string }   // DELETE /api/push/subscribe { id }
export interface DeclarativePush {                           // what the server sends on a needs-you transition
  web_push: 8030;
  notification: { title: string; body: string; navigate: string; tag: string; silent?: boolean };
  app_badge?: number;
}

// ---- budgets (gzip-9 bytes unless stated; ARCHITECTURE.md §9) ---------------------------------

export const BUDGET = {
  shell_js_kb: 30,
  view_js_kb: 15,
  md_vendor_kb: 25,
  css_kb: 12,
  fonts_kb: 80,          // identity bytes: woff2 is already compressed
  term_js_kb: 130,
  server_js_kb: 140,
  lcp_ms: 2500,
  tbt_ms: 200,
  rss_mb: 150,
  parity_diff_pct: 0.5,
} as const;
