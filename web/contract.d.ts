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
export interface UsageEvent {
  quota: Record<string, { h5: number; wk: number }>;
  thr: number;
  accts: Record<string, { id: string; label: string; today: number; week: number; month: number;
                          block: { cost: number; rate: number } | null; tokExp: number | null }>;
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
  system?: SystemEvent & { usage: UsageEvent | null };   // when route is /system
}

export interface HistoryRow {
  a: string; sid: string; sid8: string; proj: string; mt: number; sz: number;
  title: string | null; live: boolean; canResume: boolean; acctColor: string;
}
export interface HistoryPage { rows: HistoryRow[]; page: number; pages: number; total: number;
                               accts: Array<{ id: string; label: string; color: string; n: number }> }

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
