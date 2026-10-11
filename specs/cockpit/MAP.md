# MAP — the mows cockpit as it exists on 2026-10-11

Stage 1 output of `specs/cockpit/` (see the rebuild plan). Inventory only: nothing here is a proposal.
Every row cites `file:line` or says `not verified`. Validated in Stage 2 (see `ledger.md`); the
`validated_by` marks are appended there, not edited into these sections.

**Mapped tree:** branch `feat/dashboard-live-drift-2026-10` at `87dc0ca` (PR #3), i.e. `infra/dashboard/lite.mjs`
= the deployed file (288 330 B, blob `80589487aab7`), 4101 lines. `L<n>` / `lite.mjs:<n>` = a line of that file.
Seven mappers wrote sections 1–7 independently on 2026-10-11 02:00–02:40 UTC; some mapped while the
drift copy landed, so a few line numbers are flagged by their authors as drifting (sections 3, 5).

**Row ids:** `S-` server routes · `U-`/`R-`/`E-` the /ui app · `T-`/`B-` terminal · `V-`/`E-` device · `G-`/`C-`
gates and ceilings. Section 2 (inline dashboard) has no row ids; cite it by heading, e.g. `MAP.md §2.3.1`.

**Scrubbed for the forbidden-string gate (`scripts/preflight.sh` check 3):** absolute home paths read
`$HOME/…` or `<repo>`, the mapper scratch dir reads `$SCRATCH`, and account / agent / org identifiers
read `<acct>`, `<agent>`, `<org>`, `<domain>`. The underlying files are unchanged.

**Decisions this map was taken under (owner, 2026-10-11):**
- D-U1 — scope: Stages 1–4 produce the full spec package in one pass; `/ship-spec` runs follow per phase.
- D-U2 — the live-patched `lite.mjs` is the baseline and lands on `main` via PR #3 after local QA (done: `docs/qa/2026-10-11-mobile-facelift-report.md`).
- D-U3 — "keep our UI/UX" = visual parity, verified by screenshot diff at 390×844 and 1280×800 against `docs/qa/baseline/2026-10-11-mobile-facelift/`; any deviation needs a `kept` ledger entry.
- D-U4 — `/term` is rebuilt on xterm.js 6 over the same ttyd socket; `/device` stays an iframe to ws-scrcpy / noVNC.

**Drift found while mapping (beyond PR #3):**
- `infra/webconsole/blocks/40-ccimg.html` is v1 in the repo; the deployed `term-index.html` carries `ccimg-v2` (any file type, `x-name` header) with no server counterpart in `lite.mjs` (§4.1).
- Live-only systemd drop-ins `claude-web-term.service.d/{clipboard.conf,tmux.conf}`; the shipped `clipboard.conf` documents the ExecStart (§4.1, T-21).
- Stale prose ceilings (`lite.mjs:36-39`, `README.md:481`, `docs/architecture.md:365`) say 76 800 B; the gate is 158 720 B (§6.2).

---

## 1. Server surface (lite.mjs)

Files: `infra/dashboard/lite.mjs` (4101 lines), `capability.mjs` (214), `chat-stream.mjs` (32), `claude-dash-lite.service.template` (33), `infra/caddy/Caddyfile.template` (216). Paths below are relative to `infra/dashboard/` unless prefixed. "L" = lite.mjs.
Dispatcher: `http.createServer(async (req,res)=>…)` L:3888-4054. `p = url.pathname` (L:3891). No method check unless stated. No auth in lite.mjs (grep for cookie/authorization/x-auth-request in L: 0 functional hits; L:66, L:442, L:740 are comments). Auth is Caddy `gauth` (Caddyfile.template:35-55).

### 1.1 Route table, in dispatch order
Response types: html / json / sse / 302 / 303 / 304 / 204 / bytes / text.

| id | route | method(s) | handler fn + file:line | response | side effects | consumed by |
|---|---|---|---|---|---|---|
| S-01 | /healthz | any | inline L:3892 | json `{ok,sessions,scannedAgo,sseClients}` (via send, L:2577) | none | not verified (no in-repo caller found) |
| S-02 | /api/* (prefix) | any | apiView L:3462 (called L:3894) | json (sendJson L:3459) | none | SPA |
| S-02a | /api/agents | any | apiView L:3473-3480 | json `{agents:[{name,state,last_event_at,total,cost7d}]}` | none (reads agentsIndex, 3s cache) | app/views/agents.mjs:11 |
| S-02b | /api/agents/<name> | any | apiView L:3485-3504 | json `{name,recs,events,total,cost7d,timers,timer,capability,memory}`; 404 empty if name fails AGENT_RE or not in index | execs `systemctl list-unit-files`/`list-timers` (agentTimers L:3338) and `mows-agent-meta json` via runAs (agentFrontmatter L:3449) | app/views/agents.mjs:99 |
| S-02c | /api/agents/<name>/chat | any | apiView L:3505 -> agentChat L:3414 | json `{turns:[...last 40]}` (CHAT_MAX L:3413) | none (reads `chat.jsonl`) | app/views/chat.mjs:292, :333 |
| S-02d | /api/agents/<name>/runs/<id> | any | apiView L:3506-3519 | json `{status,text}`; 404 empty on bad RUN_RE or missing status.json | none | app/views/runs.mjs:7 |
| S-02e | /api/<anything else> | any | apiView L:3471, L:3520 | 404 empty body | none | n/a |
| S-03 | /ui/assets/<name> | any | uiAssetView L:3877 (called L:3896) | bytes, 304 on matching If-None-Match, 404 empty if unknown | none | `<script src>` and importmap in uiShellHtml L:3830 |
| S-04 | /ui, /ui/* (any subpath) | any | uiView L:3870 (called L:3897) | html (SPA shell, per-response CSP nonce) | none | browser nav; PWA-adjacent links `href="/ui/agents"` (L:3855 pageChrome call) |
| S-05 | /events | any | eventsView L:2748 | sse | none | fleet.js `new EventSource('/events')` L:2994 |
| S-06 | /stream?topics= | any | streamView L:2827 | sse | none | app/store.mjs:25 |
| S-07 | /_test/chat?agent=&turn=&seq=&delta= | any | inline L:3902-3908 -> chatBroadcast L:2811; ONLY if `MOWS_TEST_HOOKS==='1'` | 204 | injects a `chat` event into subscribed /stream clients | scripts/stream-replay-check.mjs (comment L:3900-3901; file not opened: not verified) |
| S-08 | /_test/chatend?agent=&turn=&closed=&cost_usd= | any | inline L:3912-3918 -> chatEnd L:2817; same env gate | 204 | injects a `chatend` event | same as S-07 |
| S-09 | /wh/<name> | POST only (405 else) | webhookView L:3674 (called L:3920) | 202 text `queued`; 404 empty (bad name or no secret configured); 413 >1 MB; 401 `bad signature`; 503 `agent unit not installed` | `systemctl start --no-block mows-agent@<name>.service`; auth = HMAC-SHA256 of body vs header `x-mows-signature` or `x-hub-signature-256` (L:3682), secret from `~/.config/mows-agents/config` key `WEBHOOK_SECRET_<NAME>` read per request (agentsConfig L:3664) | external webhooks (GitHub); bypasses Caddy gauth (Caddyfile.template:79-83) |
| S-10 | /agents | any | agentsView L:3385 | html | execs `mows-agent residents --json` (timeout 20000 ms, L:3384, L:3400) | nav tab (pageChrome L:2419+ as `/ui/agents` by default; `/agents` is the noscript twin L:3823 uiTwinPath) |
| S-11 | /agents/<name> | any | agentDetailView L:3522 (called L:3922-3924) | html; 404 | execs systemctl list-unit-files/list-timers | link from S-10 |
| S-12 | /agents/<name>/<run> | any | agentRunView L:3557 | html; 404 | none | link from S-11 |
| S-13a | /a/agent-chat | POST (405 else, L:3581) | agentAction L:3580, chat branch L:3590-3622 | 303 to `back` | spawns detached `runuser -u <TMUX_USER> -- … mows-agent chat <name> --stream <msg>` (L:3598); stdout piped through wireChatStream -> chatBroadcast/chatEnd | app/views/chat.mjs:427 (fetch POST urlencoded); server form L:3545 |
| S-13b | /a/agent-run | POST | agentAction run branch L:3624-3631 | 303; 409 text if unit missing | `systemctl start --no-block mows-agent@<name>.service` | app/views/agents.mjs:129 (form); L:3529 |
| S-13c | /a/agent-pause | POST | agentAction L:3632-3645 | 303 | `systemctl mask --now <timer>` per timer | server form L:3529 (agentDetailView) |
| S-13d | /a/agent-resume | POST | agentAction L:3632-3645 | 303 | `systemctl unmask <timer>` then `start <timer>` | same |
| S-13e | /a/agent-stop | POST | agentAction L:3646-3656 | 303 | `process.kill(-claude_pid,'SIGTERM')` and `process.kill(pid,'SIGTERM')` if last run state==='working' | same |
| S-13x | /a/agent-<other> | POST | agentAction L:3657 | 404 empty (after name check: 400 `bad name` if name fails AGENT_RE, L:3589) | none | n/a |
| S-14 | /fleet.js | any | inline L:3927-3933; body = FLEET_JS L:2892 | bytes `text/javascript`, 304 on ETag match | none | `<script defer src="/fleet.js">` in page() L:2553 when fleetJs=true (S-34, S-35 pass true) |
| S-15 | /z | any | inline L:3934 | 204 | none (query lands in Caddy access log) | page() script L:2492, 2515, 2523 (`fetch('/z?t=dash3|vpfix…')`); webconsole blocks/30-cchome.html:7, 80-ccpaint.html:78 |
| S-16a | /shot | POST | inline L:3935-3952 | json `{ok,path}`; 413 text `too big` (>15e6 B) | writes `/opt/claude-dashboard/shots/shot-<ms>.<png|webp|gif|jpg>`; unlinks files >7 d old in same dir on every upload; NO sameOrigin check | webconsole blocks/40-ccimg.html:3, :14 |
| S-16b | /shot | any non-POST | inline L:3953-3954 | 302 `/` | none | n/a |
| S-17 | /a/del | POST (405 else) | delSession L:526 | 303; 400 `bad id`; 404; 409 `session is live — kill it first` | `fsp.unlink(<transcript .jsonl>)`; mutates in-memory `index`, `counts`, titleCache, parseCache | form L:3042 (sessionRowHtml L:3038) |
| S-18 | /a/restartall | POST | restartAll L:481 | 303 to `back` with `rs=<n>` | per live tmux pane: `kill -CONT` descendants if paused, then `tmux respawn-pane -k -t <pane>` (appends ` --resume <sid>` to bare panes) | form L:1251 |
| S-19 | /a/switch | POST | switchAction L:547 | json `{ok,current}`, 400/404/409/500 `{err}` | `runuser … web-term.sh switch <tab> <to>` (20000 ms) | webconsole blocks/75-ccsess.html:9, :83; web-term.sh:284 |
| S-20a | /a/kill | POST (405 else, L:3969) | action L:441 (called L:3970) | 303; 400 `bad name`; 403 `bad origin`; 404 `not live` | `tmux kill-session -t =<name>` | form L:3076 |
| S-20b | /a/pause | POST | action L:441, branch L:456 | 303 | `kill -STOP` on pane descendants | form L:3074; fleet.js L:2929 |
| S-20c | /a/resume | POST | action L:441, branch L:456 | 303 | `kill -CONT` on pane descendants | form L:3073; fleet.js L:2928 |
| S-20d | /a/label | POST | action L:441, branch L:460 | 303 | `ccname -t <name> [label]` via runAs (writes `~/.local/state/cc-labels/<name>`) | form L:3075, L:1348 |
| S-20x | /a/<other> | POST | action L:441, else-branch L:465 | 404 empty | none | n/a |
| S-21 | /watch, /droid, /settings | any | inline L:3974-3976 | 302 `/device` | none | legacy bookmarks |
| S-22 | /droid/touchtest | any | inline L:3977 (TOUCHTEST L:645) | html | none | not verified (no in-repo link found) |
| S-23 | /droid/start, /droid/stop | POST (405 else) | droidAction L:693 | 303 `/device?dv=mobile` | `docker start redroid` + `adb connect 127.0.0.1:6555`; or `adb disconnect` + `docker stop redroid` | forms L:725-726 |
| S-24 | /watch/start, /watch/stop | POST | watchAction L:581 | 303 `/device?dv=web` | `systemctl start|stop claude-qa-watch.service` (20000 ms) | forms L:797-798 |
| S-25 | /themes.json | any | inline L:3986 | json (THEME_MAP, 12 keys in `infra/webconsole/themes.json`) | none | none found in repo — 46-cctheme.html:11 is a comment; the block fetches only `/settings/term-theme.json` (:50) [V1a] |
| S-26 | /settings/term-theme.json | any | inline L:3987-3992 | json `{name,theme}` | reads settings.json | webconsole blocks/46-cctheme.html:12, :50 |
| S-27 | /settings/term-theme | POST (405 else) | termThemeAction L:762 | json `{ok,name}`; 400 `invalid json`/`invalid body`/`unknown theme`/`too large` (>4096 B) | writes `termTheme` into settings.json (saveSettings L:159) | none in repo (comment L:1241 says "no dashboard UI"); SETUP.md:345 |
| S-28 | /sys/reclaim | POST (405 else) | reclaimAction L:1113 | 303 to `back` with `sys=1&freed=&rn=` | runs selected `RT` targets (L:1076, 12 ids: journal apt npm go uv pip gyp docker shots tmp browsers vol): journalctl vacuum, apt-get clean, rm -rf caches, docker prunes, shots/tmp sweeps | form L:1144 |
| S-29 | /app | any | appView L:2613 | 302 to `/term/?arg=attach|open&arg=<name|sid8>&arg=<tabid>&v=3` or `/term/?v=3` (never `menu` [V1a]), `cache-control: no-store` | reads `~/.cache/webterm-last`, tmuxLive | PWA manifest start_url (L:2709) |
| S-30 | /app/live.json?tab=<8 hex> | any | liveJson L:2622 | json `[{name,label,current}]`, `no-store`; 400 `{err:'bad tab'}` | `tmux list-clients` via runuser | webconsole blocks/75-ccsess.html:86 |
| S-31 | /device[?dv=mobile|web] | any | deviceView L:861 | html (auto-refresh meta 4s when android booting L:896) | execs `docker inspect`, `adb getprop`, `adb wm size`, probes TCP :6080 | nav tab |
| S-32 | /md?f=<abs path>[&dl=1] | any | mdView L:2360 | html; or bytes `text/markdown` attachment (`dl`); 400/403/404 html | reads file; only `.md/.markdown/.txt`, realpath under MD_ROOT `/home` (L:2231), <=2 MB | links from L:2224, L:2285, L:2379, L:2383 |
| S-33 | /system[?fresh=1 / reclaim=1 / freed= / rn= / rs=] | any | systemView L:3148 | html; `fresh` -> 303 `/system?…sys=1` (bounceFresh L:4008) | `fresh`: `usage(true)` = `claude-quota --refresh` + ccusage x4 per account (L:948-994); `reclaim=1`: reclaimScan L:1106 (du, docker df, journalctl); always: `claude --version` (5 min cache), `fs.stat(lite.mjs)` | nav tab |
| S-34 | / | any | homeView L:3136 | html; 302 `/history`+query if any of `q acct d s page`; else 302 `/system`+query if any of `fresh sys reclaim` (L:4018-4030) | `freshen()` (rescan if >15 s) | nav tab; PWA scope |
| S-35 | /history | any | listView L:3175 | html; `fresh` -> 303 `/history?…sys=1` | `freshen()`; titleOf reads first 64 KB of each row on page | nav tab |
| S-36 | /sessions, /projects | any | inline L:4036 | 302 `/history` | none | legacy |
| S-37 | /s/<acct>/<sid> (SESSION_PATH_RE L:122, built from startup account list) | any | detailView L:3236 | html; 404/500 html | `freshen()`; reads the transcript | links from S-35, S-34, usage panel L:1179 |
| S-38 | /manifest.webmanifest | any | manifest L:2704 | json `application/manifest+json` via send | none | `<link rel=manifest>` page() L:2444+; uiShellHtml; Caddy `pwa` (no auth) |
| S-39 | /sw.js | any | inline L:4040; body SW L:2720 | bytes `text/javascript` | none | page() script `serviceWorker.register('/sw.js')`; Caddy `pwa` |
| S-40 | /icon-192.png /icon-512.png /apple-touch-icon.png(180) /favicon.png(48) /favicon.ico(48) | any | inline L:4041-4049; iconPNG L:2674 | bytes `image/png`, `cache-control: public, max-age=86400`; colour from `hostAcct(req)` (L:2703) else `#00d492` | none | manifest, page() `<link rel=icon>`; Caddy `pwa` |
| S-41 | everything else | any | inline L:4050 | html 404 `not found. ← sessions` | none | n/a |
| S-42 | thrown error | any | catch L:4051-4053 | html 500 `error: <message>` (message HTML-escaped) | none | n/a |

Counts: dispatcher top-level branches = 42 (S-01..S-42). Table rows incl. lettered sub-shapes = 57 [V1a recount], of which 2 are the 404/500 fallthroughs and 3 are `x` unknown-action rows. S-23, S-24 and S-40 each hold 2, 2 and 5 paths in one row.
POST-accepting actions (method-enforced or POST-only behaviour): 20 = /a/agent-chat, /a/agent-run, /a/agent-pause, /a/agent-resume, /a/agent-stop, /a/del, /a/restartall, /a/switch, /a/kill, /a/pause, /a/resume, /a/label, /droid/start, /droid/stop, /watch/start, /watch/stop, /settings/term-theme, /sys/reclaim, /shot (POST), /wh/<name>.
sameOrigin() guard (L:64-69; true when neither Origin nor Referer present, else exact host match) is applied in: action, restartAll, delSession, switchAction, watchAction, droidAction, termThemeAction, reclaimAction, agentAction. NOT applied in: /shot POST, /wh (HMAC), /_test/*, GET routes with side effects (`?fresh=1` S-33/S-35).
SSE endpoints: 2 (/events, /stream).
GET routes with side effects: `/system?fresh=1` and `/history?fresh=1` (usage re-collect), `/_test/*` (env-gated), `/app` (none, redirect only).

### 1.2 SSE endpoints
| item | /events (S-05) | /stream (S-06) |
|---|---|---|
| handler | eventsView L:2748 | streamView L:2827 |
| client cap | `SSE_MAX = 8` (L:2746), counter `sseClients` (L:2747) | same constant, counter `streamClients.size` (L:2828); separate counters so 8+8 (comment L:2739-2745) |
| over cap | 503, header `retry-after: 30`, body text `too many /events clients` (L:2749); no content-type set | 503, `retry-after: 30`, body `too many stream clients` (L:2828) |
| response headers | `content-type: text/event-stream`, `cache-control: no-store`, `connection: keep-alive` (L:2751) | same (L:2831); additionally `res.flushHeaders()` (L:2838) |
| heartbeat | `: hb\n\n` every 25000 ms (L:2779) | same (`hb = setInterval(…, 25000)` L:2881) |
| poll interval | 2000 ms (`setInterval(tick, 2000)` L:2778) | 2000 ms (L:2880) |
| first tick | awaited before timers arm (L:2776) | awaited (L:2878) |
| `id:` usage | none | only on `chat` events: `<agent>:<turn>:<seq>` (chatBroadcast L:2815, streamWrite L:2802-2805); none on fleet/agents/chatend |
| Last-Event-ID | not read | read at L:2847; split on `:` into agent/turn/seq; replay only if `topics.has('chat:<agent>')` and the in-flight buffer `chatBuf.get(agent).turn` equals; sends buffered deltas with `seq > lastSeq` (L:2847-2862). chatend and fleet/agents are never replayed |
| `retry:` field | not emitted | not emitted |
| topics | none (fleet only) | `?topics=` comma list, default `fleet` (L:2830); recognised: `fleet`, `agents`, `chat:<agent>`; unknown names accepted silently, produce no events |
| event names | `fleet` | `fleet`, `agents`, `chat`, `chatend` (client listens to exactly these 4: app/store.mjs:26) |
| payload | `fleet`: array of `{sid8,name,label,proj,state,rel,snippet}` (fleetEventPayload L:2734; `rel` = raw mt ms epoch) | `fleet`: same array. `agents`: array of `{name,state,last_event_at,total,cost7d}` (L:2873). `chat`: `{agent,turn,seq,delta}`. `chatend`: `{agent,turn,...summary}` where summary keys seen: `cost_usd,is_error` (L:3610), `closed:true` (fallback L:3616) |
| emit rule | only when JSON string differs from previous tick (`last`, L:2773) | per-topic diff (`lastFleet`, `lastAgents`, L:2864-2875); chat events pushed on arrival, not polled |
| cleanup | `req 'aborted'`, `req 'close'`, `res 'close'` (L:2768) | same (L:2844) |
| Caddy handling | `(sse)` snippet: `handle /events` with `flush_interval -1` (Caddyfile.template:103-109); excluded from `encode` via `@nosse not path /events` (:122, :163) | no mention in Caddyfile.template (grep "stream" hits only comments); falls to catch-all `reverse_proxy 127.0.0.1:3005` (:152, :172) with `encode zstd gzip` applied. Whether Caddy auto-flushes `text/event-stream` and whether `encode` compresses it: not verified |

### 1.3 Shared server helpers the UI depends on
| name | file:line | returns / keys |
|---|---|---|
| fleetState() | L:376 (compute L:382) | 3 s cache + in-flight dedup. Array sorted by ORDER `needs-you(0) working(1) paused(2) idle(3)` (L:404) then mt desc. Item keys (L:401): `name, sid8, a, label, proj, row, mt, state, paused, attached, snippet, l` |
| fleetEventPayload(fleet) | L:2734 | `[{sid8: f.sid8||f.name (fleetKey L:3059), name, label, proj, state, rel: f.mt, snippet}]` |
| classifyFleet({paused,tail,mt}) | L:357-365 | state strings, first match wins: `paused` (L:358, tmux descendant in state T), `needs-you` (L:359 regex `FLEET_RE.dialog`; L:363 idle-prompt + transcript <600000 ms), `working` (L:364: `esc to interrupt`, workflow-monitor regex, or mt <45000 ms), `idle` (L:365). Regexes FLEET_RE L:340-355 |
| tmuxLive() | L:255 (compute L:261, push L:275) | 3 s cache. `[{name,sid,attached,created,activity,pid,cwd,paneId,label,paused}]`, first pane per session; source `tmux list-panes -a` via `runuser -u TMUX_USER` |
| tailOf(e) | L:300 | `{mt,text}` last 16 KB newest assistant/user text, 160 chars; mtime-cached |
| titleOf(e) | L:208 | `{mt,title,ts}` from first 64 KB; 120 chars |
| discoverAccounts() | L:95 (called once at module load, `const ACCTS` L:110) | `[{id,label,home,user,agent,color,term}]`; scans `/home/*` and `$HOME` for `.claude`, `.claude-<suffix>` with a `projects/` subdir; sorted humans first; startup-only (no re-scan) |
| scan()/freshen() | L:194 / L:201 | in-memory `index[]` `{a,sid,path,mt,sz,proj}`; rescan if >15000 ms on page requests; `setInterval(freshen,30000)` L:4100 |
| agentsIndex() | L:3300 | 3 s cache; `[{name,last,recs(<=20),cost7d,total,events(last 5 lines)}]`; run state values written by mows-agent write_status: `working`, `done`, `failed`, `stalled`, `budget_exceeded` (agents/bin/mows-agent:278, :298-305); dashboard adds `failed`+`crashed:true` when pid dead (L:3314); sort rank working < {stalled,failed,budget_exceeded} < rest |
| agentCapability(fm,{webhookArmed}) | capability.mjs:87 | keys: `effective, broad, narrow, hasBroad, authorities[{kind,beyondList,tools}], inherits, malformedTools, malformedDenied, mcpTools, unclassifiedTools, miscasedTools, denyNoop, denyLoadBearing, denied, policy{profile,workdir,budget,model,soul,permissionMode,maxTurnsDeclared,turnCapDisagreement,triggers,triggerTypes,webhookArmed,webhookDeclaredInert}`. AUTHORITIES kinds: shell, subagent, command, write, network (capability.mjs:33-39). Exports: AUTHORITIES, BROAD_TOOLS, agentCapability |
| agentTimers/summarizeTimers | L:3338 / L:3367 | timers `[{unit,masked,next}]`; summary `{state:none|paused|active|mixed,label}` |
| wireChatStream(stdout,onDelta,onEnd) | chat-stream.mjs:6 | parses NDJSON from `mows-agent chat --stream`; line with `.end` -> onEnd(o), else onDelta(o) (`{seq,delta}`); returns `{drops()}` |
| hostInfo() | L:913 | 5 s cache `{load,cores,memUsed,memTot,swapUsed,swapTot,dskUsed,dskTot,up}` from /proc/meminfo, statfs('/'), os |
| usage()/collectUsage() | L:994 / L:948 | 300 s cache `{quota:{<qkey>:{h5,wk}}, thr, accts:{<id>:{id,label,qkey,tokExp,cc,today,week,month,models[{name,cost}],days[{d,cost,models}],sess[{sid,cost,models}],block:{cost,rate}|null}}}`; sources `claude-quota --line`, `ccusage daily|monthly|session|blocks`, `<home>/.credentials.json` expiresAt only; warmed at boot L:1003 |
| claudeVersion() | L:1007 | string or null; `claude --version`, 5 min cache |
| droidState() / watchLive() | L:684 / L:576 | `{state:'stopped'|'booting'|'live', res}`; TCP probe :6080 (3 s cache) |
| readSettings()/saveSettings(patch) | L:150 / L:159 | whole JSON object from `SETTINGS_FILE` (default `/opt/claude-dashboard/settings.json`, L:132, flag `--settings-file` or env `SETTINGS_FILE`); save = read, shallow-merge, `mkdir -p`, writeFile pretty JSON, not atomic. Only key written by any route: `termTheme` (L:762-780). Read by S-26 only |
| loadThemeMap() | L:134 | reads `themes.json` next to lite.mjs, else `../webconsole/themes.json`; `{}` + warn if absent |
| send(req,res,status,html,type,extra) | L:2577 | sets `content-type`, `cache-control: no-cache`; CSP BASE_CSP on text/html; gzip if body >1024 B and `accept-encoding` has gzip |
| page(...) / pageChrome(...) | L:2444 / L:2419 | server-rendered document shell and header/tabs/FAB; tab list: Sessions `/`, History `/history`, System `/system`, Device `/device`, Agents `/ui/agents` (pageChrome L:2419) |

### 1.4 Static / asset serving
- `UI_DIR = ./app/` (L:3702). loadUiAssets L:3727 walks recursively, keeps only extensions in `UI_ASSET_TYPES` (L:3722-3726): `mjs` text/javascript; charset=utf-8, `css` text/css; charset=utf-8, `woff2` font/woff2 (3 entries; any other extension is not served). Runs at boot before listen (L:4099) and lazily if map empty (L:3871, L:3878).
- Hash scheme: uiAssetName L:3704 inserts `crc32(buf)` hex before the extension (`vendor/preact.1a2b3c4d.mjs`). The ETag is the same crc32 in quotes (L:3737-3738). Keys in map = hashed names; request name must equal hashed name exactly.
- Response (L:3877-3885): `200`, `content-type`, `etag`, `cache-control: public, max-age=31536000, immutable`, `content-length`; no gzip in lite.mjs; 304 on matching `if-none-match` carries only `etag` (no cache-control); 404 empty body for unknown. No method check.
- Importmap (uiShellHtml L:3830-3850): bare specifiers `preact`, `preact/hooks`, `htm`, `marked` -> hashed vendor files; plus per-file entries `/ui/assets/<rel>` -> hashed, excluding `vendor/*`. Entry module: `<script type=module src=uiAssetUrlFor('main.mjs')>`.
- Files in app/ (bytes): main.mjs 2582, store.mjs 1899, ui.mjs 566, views/{agents 11096, capability 12780, chat 32523, runs 839}.mjs, vendor/{hooks 3729, htm 1207, marked 92829, preact 11429}.mjs, vendor/inter-var-latin.woff2 48256, vendor/jetbrains-mono-var-latin.woff2 31432, vendor/SHA256SUMS (not served, extension absent from map). Total 251656 B.
- Fonts: `cssText()` (L:3758) substitutes placeholders `FONT_INTER`, `FONT_MONO` in the `CSS` constant (L:1358) with hashed `/ui/assets/vendor/*.woff2` URLs; comments stripped; cached. The CSS is inlined in every HTML response (`<style>`), both server-rendered (page() L:2444) and SPA shell (L:3861).
- Icons: no files. PNGs drawn in code (iconPNG L:2674, cache Map by size+colour); 5 paths (S-40). Icon in manifest: 192, 512, 512 maskable (L:2713-2716).
- Manifest (L:2704-2719): `id '/'`, `name` `mows sessions` (or `mows · <label>` on a per-account host), `short_name`, `start_url '/app'`, `scope '/'`, `display standalone`, `background_color`/`theme_color` `#09090b`.
- SW (L:2720-2727): install -> skipWaiting, activate -> clients.claim, fetch handler only for `mode==='navigate'`: network, fallback to an inline offline page. No caching.
- /fleet.js: FLEET_JS inline string L:2892; `cache-control: public, max-age=300` + crc32 ETag (L:3927-3933).
- `/term*` is not lite.mjs: Caddy serves `/opt/claude-dashboard/term-index.html` for `/term` and `/term/` (Caddyfile.template:137-143), other `/term*` -> ttyd 7681 (:144-150), apex vhost only. `/vnc/*` -> 6080 (:59-62), `/droidview/*` -> 8000 (:69-72).

### 1.5 Headers and policy
| route family | CSP | cache-control | compression | cookies |
|---|---|---|---|---|
| server-rendered HTML via send() (S-10..12, 31-37, 41, 42, S-32 html) | BASE_CSP L:2576: `base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'self'` (no script-src/style-src; inline scripts and style attributes are used throughout, comment the comment above uiCsp) | `no-cache` | lite gzip if >1024 B and client accepts; Caddy `encode zstd gzip` also in front | none set |
| /ui (S-04) | per-response nonce, uiCsp L:3798: `default-src 'none'; script-src 'self' 'nonce-N'; style-src 'nonce-N'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`. Replaces BASE_CSP (Object.assign, L:2585) | `no-cache` (send) | as above | none |
| /ui/assets/* (S-03) | none | `public, max-age=31536000, immutable` | none in lite; Caddy `encode` applies (compression of mjs/css/woff2 specifically: not verified) | none |
| JSON / JS via send() (S-01, S-02*, S-25, S-26, S-38, S-39) | none (CSP only on text/html, L:2584) | `no-cache` | lite gzip rule | none |
| /app (S-29), /app/live.json (S-30) | none | `no-store` | n/a | none |
| /fleet.js | none | `public, max-age=300` + ETag | Caddy | none |
| icons (S-40) | none | `public, max-age=86400` | n/a | none |
| /events, /stream | none | `no-store` | excluded from Caddy encode for /events only | none |
| /md?dl=1 | none | `no-store`, `content-disposition: attachment; filename*=UTF-8''<name>` | n/a | none |
| /z, /_test/* | none | none | n/a | none |
- Caddy `gauth` snippet (Caddyfile.template:35-55) sets `Strict-Transport-Security max-age=31536000; includeSubDomains`, `X-Content-Type-Options nosniff`, `Content-Security-Policy "frame-ancestors 'self'"`, `Referrer-Policy same-origin`; applies to every path except `pwa` paths (S-38..S-40) and `/wh/*` which are `handle`d earlier in the route (:86-92, :79-83, order :125-130). How Caddy's CSP header and lite's CSP header combine on the same response (replace vs duplicate): not verified.
- Auth: `forward_auth 127.0.0.1:4180 uri /oauth2/auth`, copies `X-Auth-Request-Email`; 401 redirects to `https://{{DOMAIN}}/oauth2/start?rd=…` (:44-54). lite.mjs never reads `X-Auth-Request-Email`. Cookie is oauth2-proxy's; lite.mjs sets none (page footer links `/oauth2/sign_out`, L:2455).
- Caddy route order, both site blocks (:124-154, :165-173): `pwa`, `webhook`, `gauth`, `vncproxy`, `droidproxy`, `sse`, then (apex only) `/term*` handlers, then catch-all `reverse_proxy 127.0.0.1:3005`. Per-profile subdomain block has no `/term*` handler: `/term` there goes to 3005 and hits S-41 (not verified live).
- `hostAcct(req)` (L:2703) maps first Host label to an account (used for manifest name and icon colour only) and `listView` default `acct` filter (L:3177).

### 1.6 Process shape
- Unit (claude-dash-lite.service.template): `Type=simple`, `User=root` (:25, rationale :7-24), `ExecStart=/usr/bin/node /opt/claude-dashboard/lite.mjs --port 3005 --host 127.0.0.1` (:26), `Restart=on-failure`, `RestartSec=3` (:27-28), `OOMScoreAdjust=-200`, `MemoryMax=400M` (:29-30), `WantedBy=multi-user.target`, `After=network.target`. No `Environment=` lines; no `EnvironmentFile`.
- CLI flags read (L:123-126, L:130, L:4056): `--port` (default 3005), `--host` (default 127.0.0.1), `--resume-days` (default 7), `--settings-file`, `--selftest` (L:4056: runs scan + 8 FLEET_FIXTURES + md smoke, exits).
- Env vars read: `HOME` (L:104), `SETTINGS_FILE` (L:132), `WEBTERM_SH` (L:945, default `/opt/claude-dashboard/web-term.sh`), `MOWS_TEST_HOOKS` (L:3902, L:3912). `PORT` env: not read. No `MOWS_*` other than `MOWS_TEST_HOOKS`.
- Boot sequence: discoverAccounts at import (L:110) -> loadThemeMap (L:148) -> `usage()` warm (L:1003) -> `await scan()` (L:4096) -> `await loadUiAssets()` (L:4099) -> `setInterval(freshen,30000).unref()` (L:4100) -> `server.listen` (L:4101).
- Files read at boot: `/home/*/.claude*/projects/**/*.jsonl` stat only (scanAcct L:172), `themes.json`, `./app/**` (all allowed extensions, fully into memory). Files read per request: `settings.json`, `~/.config/mows-agents/config`, `~/.local/state/mows-agents/**` (runs, chat.jsonl, memory.md, events.log), `~/.cache/webterm-last`, `~/.cache/webterm-clients/<tab>`, `<home>/.credentials.json` (usage, expiry only), transcripts, `/proc/meminfo`.
- Files written: `settings.json` (S-27), `/opt/claude-dashboard/shots/*` (S-16a), transcripts deleted (S-17), cache dirs removed (S-28). Sibling modules imported: `./chat-stream.mjs` (L:60), `./capability.mjs` (L:61); `node:` builtins only; no npm deps. Install list: install.sh:382-383 copies lite.mjs, chat-stream.mjs, capability.mjs, and `app/`; themes.json installed separately (SETUP.md:348).
- External commands exec'd (runuser as TMUX_USER or direct): tmux, ps, kill, runuser, ccname, claude, claude-quota, ccusage, mows-agent, mows-agent-meta, systemctl, docker, adb, journalctl, apt-get, du, web-term.sh.
- sh() timeout 5000 ms (L:250); runAs default 30000 ms, maxBuffer 32e6 (L:935-937).
- Single process, single event loop; cache TTLs: tmux 3 s, fleet 3 s, agents 3 s, host 5 s, usage 300 s, claude version 300 s, droid/watch probe 3 s, session index 15 s staleness, `unref` 30 s interval.

### 1.7 Not verified / gaps
- No live run; everything from static reading of the branch copy. The deployed Caddyfile/unit on the box may differ from the templates.
- Row count: S-01..S-42 are the dispatcher's top-level branches; lettered sub-shapes are counted from the handlers by reading, not by enumerating a live route list.
- Whether Caddy compresses or auto-flushes `/stream` (text/event-stream) with only the catch-all handler: not verified. Caddyfile.template names only `/events` for flush/encode exclusion.
- How Caddy's `Content-Security-Policy: frame-ancestors 'self'` interacts with lite's CSP header on the same response: not verified.
- Callers of /healthz, /droid/touchtest, and POST /settings/term-theme: none found in repo (no external probe checked).
- `scripts/stream-replay-check.mjs` (consumer of S-07/S-08) and `infra/webconsole/` blocks beyond the grepped lines: not opened.
- Line citations were re-checked against grep for the dispatcher, SSE handlers, caches, CSP and asset loader; the per-branch line numbers inside action/agentAction/apiView were read from a numbered grep, not re-read in context.
- Method checks: only the routes marked POST-only enforce a method; every other route answers any method (incl. HEAD/POST) with its GET behaviour.
- Account list, SESSION_PATH_RE and HOST_ACCT are fixed at process start; a profile added later is invisible until restart (service template comment :18-24).
- `scripts/preflight.sh` and `e2e-infra.sh` size gates referenced in comments (L:35-39, L:3713-3718): not opened.


## 2. Inline dashboard
Source: `<repo>/infra/dashboard/lite.mjs` (4101 lines, 288330 B; branch feat/dashboard-live-drift-2026-10). All `L<n>` = lines in lite.mjs. Live fetches from http://127.0.0.1:3005 on 2026-10-11. No framework: every view is one template-literal string; CSS is ONE shared `CSS` const (L1358-2217; V3 corrected the end anchor from 2231, which included 14 trailing MD_ROOT lines) inlined into every page via `cssText()` (L3758).

### 2.1 Shared chrome
`page(title, body, head, bodyClass, tab, fleetJs, liveN, host)` L2444 wraps `pageChrome(tab, liveN, host, agentsHref='/ui/agents')` L2419 (also used by `uiShellHtml` L3830). Document order, verified on served `/`:
```
<html lang=en><head>
  meta viewport = width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content  (L2447)
  meta color-scheme=dark ; meta theme-color=#09090b
  link manifest /manifest.webmanifest crossorigin=use-credentials ; link icon /favicon.png ; link apple-touch-icon /apple-touch-icon.png
  meta mobile-web-app-capable=yes ; meta apple-mobile-web-app-capable=yes ; meta apple-mobile-web-app-status-bar-style=black-translucent
  ${head} (per view: <meta http-equiv=refresh 4>, <style>MD_CSS</style>, mermaid <script type=module>)
  <script type=speculationrules> (L2453) ; <title> ; <style>cssText()</style>
<body class="${bodyClass}">
  header.hdr.navdup                      (desktop only; hidden <=700px via .navdup L1672)
    div.hdl > span.hlogo ">_" + div.hcol > div.htitle "mows control" + div.hsub "Connected · <host>"
    nav.pnav > a(.on)×5: Sessions [b.pbdg#pnav-live N, hidden if 0, only when liveN!=null] | History | System | Device | Agents
    a.hnew href=termHref('menu','') > svg.plus + span.hnew-lbl "New Session"
  a.termfab href=termHref('menu','') title/aria "open terminal" > svg.terminal   (fixed FAB)
  ${body}   (always starts with <h1>)
  nav.tabs  (mobile bottom bar; display:none base L1398)
    a.tb(.on) > span.ti>svg + label   ×5
  footer > a "sign out" /oauth2/sign_out + span "lite · no-js · <N> indexed" + span#envout (JS fills "app|tab · sat<n> sab<n>")
  <script> base inline script (6834 B)  [+ <script defer src=/fleet.js> only if fleetJs]
```
**Tab list** (L2420-2435; same order in `.pnav` and `.tabs`):
| label | href | `.tb` icon (ICO key) | active when `tab`= |
|---|---|---|---|
| Sessions | `/` | list (`M8 6h13M8 12h13M8 18h13M3 6h.01…`) | `sessions` |
| History | `/history` | history | `history` |
| System | `/system` | activity (`M22 12h-4l-3 9L9 3l-3 9H2`) | `system` |
| Device | `/device` | monitorSmartphone | `device` |
| Agents | `/ui/agents` (default `agentsHref`; SPA twin, NOT /agents) L2419,2425,2435 | wrench | `agents` |
Active = class `on` (`.pnav a.on` L1570s: bg var(--pop), fg, shadow 0 1px 3px rgba(0,0,0,.4); `.tb.on` color var(--ok) L1670, facelift pill bg var(--ok-bg) + inset ring var(--ok-bd) L2167-2168). Pages passing tab='' (detail `/s/..`, `/md`, 404) highlight nothing; `/s/` sets bodyClass `sessions` (no CSS rule); `/device` sets bodyClass `watchlive` when droid live or noVNC up (L895: hides `.termfab`, widens body to 1720px L1389). Badge `#pnav-live` shown only on `/` and `/history` (liveN passed L3143,3233), kept fresh by fleet.js.
**Tab icons** = inline lucide-style SVG, 16x16 attr, 24 viewBox, stroke currentColor 2px; sized by CSS: `.ti svg` 20px (L1440), `.termfab svg` 22px, `.hnew svg` 16px, `.ab/.chip/.dx svg` 14px. ICO set (L602-638, 30 glyphs [V1a]): smartphone monitor refresh arrowLeft square cast play keyboard clipboard chevronUp/Down/Left/Right chevronsLeft/Right history activity list monitorSmartphone x pencil pause ellipsis trash terminal plus send wrench search maximize.
**Header `h1` anatomy** (every view body begins with `<h1>`): `h1{16px/650 flex gap9}` L1399, `h1::before` = `>_` badge (mono 700 12px, color var(--ok), bg var(--ok-bg), 1px var(--ok-bd), radius 9px, pad 6/7) L1400. Desktop (>=701px) `body>h1{display:none}` L1393 (the `.hdr` replaces it). Mobile facelift: 26px/700/-.03em, badge radius 12 + glow `0 0 24px rgba(0,212,146,.18)` L2141-2143; `h1 .muted` 15px/500.
 h1 text per view: `/` "mows" (link /) ; `/history` "mows · history [· <host-acct>]" ; `/system` "mows · system" ; `/device` "mows · device" ; `/agents` "mows · agents" ; `/agents/<n>` "← agents · <n>" ; run "← <n> · <run>" ; `/md` "mows" ; `/s/..` "← sessions".
**Desktop header geometry** L1562-1580: `.hdr` flex space-between gap16 height50 margin-bottom 48; `.hlogo` 32x32 radius8 bg var(--fg) color var(--bg) mono 700 18px; `.htitle` 500 16/1.2 ls-.4px; `.hsub` mono 12px opacity .6 mt2; `.hnew` pill bg var(--fg)/color var(--bg) pad 10/20 500 14px, hover #e4e4e7; `.pnav` pill (bg var(--navbg), 1px var(--navbd), pad6, h50), `.pnav a` pad 8/20 500 14px; `.pbdg` bg var(--bg) pad 2/6 mono 500 12px color #d4d4d8. <=920px: `.hsub{display:none}`, `.hnew` icon-only (pad10, `.hnew-lbl` hidden) L1580.
**`.termfab`** (L1582-1584): fixed right14 bottom `calc(70px + safe-bottom)` z21, 46x46 circle, bg var(--ok), color #052018, shadow `0 6px 18px rgba(0,0,0,.45)`, hover #4ade9e; >=701px bottom:14px; hidden by `body.watchlive`/`body.devfs`; facelift (<=700): right18 bottom `calc(var(--tbo)+74px)` 54x54 + 3-layer glow L2170. Standalone PWA anchors it from TOP: `top:calc(min(100lvh,100%) - 116px - safe-bottom)` L1691 (facelift: `-128px - var(--tbo)` L2215). `href` = `/term/?arg=menu&arg=&arg=<tabid8hex>&v=3` (`termHref` L2602; tabid random per render).
**Tab bar `.tabs`**: base `display:none` L1398; <=700px `position:fixed bottom0 left/right0 z20 flex`, bg rgba(9,9,11,.88) + backdrop blur14, border-top 1px var(--bd), pad `5px 0 calc(5px+safe-bottom)` L1667; `.tb` flex1 column min-h48 11px color var(--dim), `.ti` 18px; `.tabs{view-transition-name:tabs}` L1872. Facelift (L2137-2176): floating glass pill `left/right 12px bottom var(--tbo)`, radius 30, bg rgba(24,24,27,.72), blur20 saturate160, border 1px rgba(255,255,255,.08), shadow `0 12px 32px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05)`; `.tb` radius24 font 500 10.5px; `.tb .ti` 46x28 pill. `--tbo: max(10px, calc(env(safe-area-inset-bottom,0px) - 8px))` L2138. Standalone: `.tabs{bottom:auto;top:calc(min(100lvh,100%) - 59px - safe-bottom)}` (facelift `-60px - var(--tbo)`) L1689-1697, L2213-2216; `body{min-height:100lvh}`.
**Safe-area handling**: viewport-fit=cover; mobile `body{padding:max(8px,env(safe-area-inset-top,8px)) 8px calc(72px + env(safe-area-inset-bottom,0))}` L1658 (facelift bottom 96px L2139); `body::before` fixed top blur strip height `env(safe-area-inset-top)` bg rgba(9,9,11,.88) blur14 z20 L1675; `#ptr` top uses safe-top L1589; `.fsbtn` max(10px, safe-*) L1838. Base script (a) `#envout` diag + `/z?t=dash3&…` beacon after 700ms (L2476-2493); (b) **vpfix** L2494-2530, standalone+portrait only: when `innerHeight+4<screen.height` toggles `body.style.display` none->'' to re-measure, up to 6x, then one `location.reload()` per 30s (sessionStorage.vpr); beacons `/z?t=vpfix`; triggers pageshow/visibilitychange/resize/120ms.
**Speculation rules** L2453: `prerender`, eagerness `moderate`, where href_matches [`/`,`/?*`,`/history`,`/history?*`,`/system`,`/device`,`/s/*`,`/agents`,`/agents?*`,`/agents/*`] AND NOT selector `a[href*='fresh=1'],a[href*='reclaim=1'],a[data-norun],a[href^='/ui']` (so /term, /ui, side-effect links never prerender; the Agents tab, which points to /ui/agents, is therefore not prerendered). `/agents/<n>/<run>` run links carry `data-norun`.
**View transitions** L1871-1877: `@view-transition{navigation:auto}`; `::view-transition-old(root)` .12s ease vt-out (opacity->0); `::view-transition-new(root)` .18s cubic-bezier(.2,.7,.3,1) vt-in (from opacity0 translateY(6px)); reduced-motion kills `::view-transition-group/old/new(*)`. Tab bar pinned by view-transition-name.
**Other base-script behaviors**: SW register `/sw.js` L2456; `submit` -> `form.busy` (pointer-events none, buttons pulse `busy` 1s) and pageshow clears it (bfcache restore) L2458-2459/L1878; `a[data-nw]` gets `target=<data-nw>` ONLY if `display-mode:browser && innerWidth>=700 && pointer:fine` L2470-2471 (named window reuse, deliberately no noopener); PTR L2531-2553 (see 2.4).
**bfcache assumptions**: HTML sent `cache-control: no-cache` (never no-store) L2577-2580 (header comment L25-28); `pageshow` handlers exist for busy-clear + vpfix reset. `/events` is `no-store`. Whether an open EventSource blocks bfcache: not verified.
**Security headers** on every HTML (L2576): CSP `base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'self'` (no script/style policy; inline allowed). `/ui*` replaces it with strict nonce CSP (L3798).
**Response**: gzip only when body>1024 B and client sends gzip (`gzipSync` default level) L2586-2587; no brotli from origin (verified: `accept-encoding: br` returns identity 68410 B for `/`). Whether Caddy re-encodes: not verified.

### 2.2 Design tokens
`:root` L1359-1373 (base, 28 vars) + L1931-1934 (3 icon masks) + L2138 (`--tbo`, in <=700 block). 32 declared custom properties; `--kb` is read (L1915, L2107) but set at runtime by the SPA view's visualViewport handler (not in lite.mjs :root).
| var | value | | var | value |
|---|---|---|---|---|
| color-scheme | dark | | --ok | #00d492 |
| --bg | #09090b | | --ok-bg | rgba(0,212,146,.1) |
| --card | rgba(24,24,27,.3) | | --ok-bd | rgba(0,212,146,.2) |
| --card2 | #18181b | | --ok-lt | #5ee9b5 |
| --pop | #27272a | | --ok-dk | #00bc7d |
| --navbg | rgba(24,24,27,.6) | | --bd3 | #3f3f47 |
| --navbd | rgba(39,39,42,.8) | | --warn | #ffb900 |
| --fg | #f4f4f5 | | --bad | #ff6467 |
| --fg2 | #d4d4d8 | | --r | 10px |
| --title | #e4e4e7 | | --r-lg | 16px |
| --mut | #9f9fa9 | | --sans | 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif |
| --dim | #71717b | | --mono | 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace |
| --dimmer | #52525c | | --ring | rgba(161,161,170,.8) |
| --bd | rgba(39,39,42,.6) | | --hair | #18181b |
| --bd2 | rgba(39,39,42,.8) | | --tbo (<=700px only) | max(10px,calc(env(safe-area-inset-bottom,0px) - 8px)) |
| --ico-restart / --ico-activity / --ico-send | `url("data:image/svg+xml,…")` stroke #000 masks (24/24/16 viewBox) L1932-1934 | | --kb | runtime, default 0px |
**Literal colors used outside tokens** (not tokenized): #052018 (on-emerald text: .termfab/.btn), #4ade9e (emerald hover), #e4e4e7 (.hnew hover), #fef3c6 (.mbar-fill.warn desktop), #f59e0b (warn gradient start), #3f3f46 (.pg .off), #050506 (details pre bg), #60a5fa (user message accent), #2563eb33/#16a34a33/#dc262633/#71717a33 (agent pills), rgba(248,113,113,.1/.35/.08) (.ab.danger/.dx hover), rgba(251,44,54,.1/.16) + rgba(130,24,26,.5) (.dangerbtn/.ctlbtn.danger), rgba(251,191,36,.35/.06) (.note), rgba(9,9,11,.7/.9) (.li2), #3f3f47 (.li2 border), #71717b (.li2 focus).
**Fonts**: Inter and JetBrains Mono, latin-subset variable woff2, weight 400-700, `font-display:swap` (L1378-1381). Files `infra/dashboard/app/vendor/inter-var-latin.woff2` 48256 B, `jetbrains-mono-var-latin.woff2` 31432 B; served as `/ui/assets/vendor/<name>.<crc32hex>.woff2` (served: `.19416575`, `.810bbf11`), `cache-control: public, max-age=31536000, immutable`, etag; placeholders FONT_INTER/FONT_MONO substituted in `cssText()` L3758. Fallback = system stacks above. Body `14px/1.5 var(--sans)` L1384.
**Font sizes in use (px)**: 9,10,10.5,11,11.5,12,12.5,13,13.5,14,15,15.5,16,17,18,19,20,23,26,30; mobile inputs forced 16px (iOS zoom) L1658/L1780/L2052.
**Radii**: tokens 10/16; literals 3,4,6,8,9,10,12,16,20,22,24,30,999,50%. Notable: cards `--r-lg`16; fleet row card 16 L1498; phone cards/tiles 22 L2149/L2182; `.kc` 16 (facelift 20 L2162); `.devstage` 24; `.devcard/.envcard/.termcard` 16.
**Shadows**: `.kc` 0 12px 32px rgba(0,0,0,.55) L1458; `.termfab` 0 6px 18px rgba(0,0,0,.45); `#ptr` same; `.pnav a.on`/`.segbtn.on` 0 1px 3px rgba(0,0,0,.4); `.li2` inset 0 1px 2px rgba(0,0,0,.4); phone card/tile `inset 0 1px 0 rgba(255,255,255,.04), 0 8px 24px rgba(0,0,0,.25)` L2149,2182; working card adds `0 0 0 1px rgba(0,212,146,.06), 0 8px 28px rgba(0,212,146,.08)` L2151; facelift tabs see 2.1; facelift fab `0 0 0 6px rgba(0,212,146,.10),0 10px 28px rgba(0,212,146,.30),0 6px 18px rgba(0,0,0,.5)`; `.agdot` ring 0 0 0 3px rgba(0,188,125,.2); `.mbar-fill` glow `0 0 12px rgba(0,212,146,.45)` (warn .45 amber).
**Mobile body bg**: `radial-gradient(120% 50% at 50% -12%, rgba(0,212,146,.10), transparent 60%) no-repeat, var(--bg)` L2139.
**Layout widths**: body max 1100 pad12 (base L1384); >=701: max 1024 pad48 L1387; `body.watchlive` 1720; `body.uiapp` 1088 pad32 L1935. `.sysgrid` 464+464 gap96 L1751; `.devrail` 320; `.devlayout` gap48; `.devstage` min-h600 radius24 dashed.
**Every @media / @supports / @view-transition / @keyframes** (24 @media statements, 11 distinct conditions):
| L | condition | what |
|---|---|---|
| 1387 | min-width:701px | body 1024/pad48, watchlive 1720, `body>h1` hidden |
| 1397 | prefers-reduced-motion:no-preference | a/button/summary color transitions .15s |
| 1475 | min-width:701px | `.row` pad 8/12 min-h36 |
| 1505 | pointer:fine | `.fact` opacity0 -> 1 on row hover/focus-within/details[open] |
| 1534 | min-width:700px and pointer:fine | `.fnum` 14px keyboard badge visible (note 700, not 701) |
| 1580 | max-width:920px | hide `.hsub`, icon-only `.hnew` |
| 1584 | min-width:701px | `.termfab{bottom:14px}` |
| 1601 | pointer:fine | history `.go`/`.kx.del` opacity0 until row hover |
| 1658 | max-width:700px | MOBILE BASE: body pad, `.chip` min-h40, hide `.fleet-rows`/show `.fleet-cards`, `.ab` min-h40, `.tabs`/`.tb`, `.navdup{display:none}` L1672, `body::before` L1675 (block ends L1688) |
| 1689 | display-mode:standalone and max-width:700px; @supports(height:100lvh) | top-anchored tabs/fab, body min-h100lvh |
| 1780 | max-width:700px | `.sys` summary, inputs 16px, `.sysgrid{display:block}`, env/term card pad20 |
| 1846 | min-width:701px | `.devstage.live` h `calc(100dvh - 210px)` min600, `.vnc` h100% |
| 1859 | max-width:700px | `.devlayout` column gap24, `.devrail` 100%, `.devstage` min-h220 (`.live` 0) |
| 1877 | prefers-reduced-motion:reduce | kill view-transition animations |
| 1884 | prefers-reduced-motion:no-preference | press scale(.96), `details[open]` pop-in .18s |
| 1935 | min-width:701px | `body.uiapp` 1088/32 |
| 2033 | max-width:1087px | `.ag2` cols `minmax(0,1fr) 300px` gap16 |
| 2034 | max-width:860px | `.ag2` single col; back arrow into card header; composer 16px; `.agchat` h `calc(100dvh - max(8px,safe-top) - safe-bottom - 80px)` |
| 2063 | max-width:700px | `.agchat` h `…- 132px`; `html.agent-view .termfab{display:none}`; `html.kb-open .tabs{display:none}` (70px variant) |
| 2106 | max-width:700px | `.uiapp .chat .chatf` / `.jump` bottom clearance vs tab bar |
| 2131 | min-width:701px and max-width:860px | `.uiapp .chat .chatf{padding-right:60px}` |
| 2137 | max-width:700px | MOBILE FACELIFT (2026-10-10), see below, ends L2175 |
| 2176 | max-width:700px | MOBILE SYSTEM FACELIFT, ends L2212 |
| 2213 | display-mode:standalone and max-width:700px; @supports(height:100lvh) | facelift standalone tabs/fab anchors |
Keyframes: `ptrspin` L1593, `lvpulse` L1598 (.68->.3 opacity 1.6s), `vt-out` L1875, `vt-in` L1876, `busy` L1879, `pop-in` L1889, `pulse` L1917. Numeric breakpoints: 700/701 (primary), 860, 920, 1087 (+ min-width:700 for `.fnum`).
**Facelift block (L2137-2175, <=700px only)** — overrides listed: `:root --tbo`; `body` bottom pad 96px + radial bg; `h1` 26px/700/1.15 pad `10px 2px 18px`; `.sect` mono 600 10.5px ls .18em color var(--mut) flex, `.sect b` var(--ok), `.sect input[type=search]` margin-left:auto flex1 max190 min-h36 radius999 font15 (all !important); `.fleet-cards` gap12; `.fleet-cards .lp` radius22 pad `18px 18px 16px` gap8 border rgba(255,255,255,.06) bg `linear-gradient(180deg,rgba(39,39,42,.55),rgba(24,24,27,.35))`; `[data-state=working]` border var(--ok-bd) + green glow; `[data-state=needs-you]`/`paused` border rgba(255,185,0,.28); title `650 17px/1.25 -.02em`; `.fli` 11px, `.fli-working` text-shadow 0 0 10px var(--ok); meta line 500 13px var(--mut); `.fsnip` mono 12/1.5 on rgba(0,0,0,.25) box, 1px rgba(255,255,255,.04), radius12 pad 8/10 mt4; `.fcact` gap8, `.fcact .ab` 42x42 circle; `.ab.ok` bg var(--ok-bg) bd var(--ok-bd); `summary.ab` bg rgba(255,255,255,.04) bd rgba(255,255,255,.07); `.kc` radius20 bg rgba(39,39,42,.92) blur18; `.newcard` radius22 pad20 mt8; tabs/tb/termfab per 2.1.
**System facelift (L2175-2212)**: `.mbar-pct{display:none}` base L2175; <=700: `.sechead` margin `0 2px 12px`, `h2` mono 600 10.5px ls .18em uppercase var(--mut), `.sechead p` hidden; `.sysleft` mb26 `.sysright` gap26 `.sysextra` mt26; `.mbars` grid 2x2 gap12; `.mbar/.envcard/.termcard/.stat` radius22 + card gradient/shadow above; `.mbar` pad16 gap12; `.mbar-row` column gap6; `.mbar-label` mono 600 10px ls .12em uppercase var(--dim); `.mbar-pct` block 650 30px/1 ls -.04em tabular; `.mbar-val` mono 11.5px var(--mut) wrap; `.mbar-track` h6 rgba(255,255,255,.06); `.mbar-fill` gradient `90deg var(--ok-dk)->var(--ok-lt)` + glow; `.warn` gradient `#f59e0b->var(--warn)`; `.mbar:has(.warn)` border rgba(255,185,0,.25) and pct var(--warn); `.envcard/.termcard` pad `6px 18px` (term 18); `.envrows` gap0; `.envrow` pad 13/0 hairline rgba(255,255,255,.05) align center; `.envdiv` hidden; `.envkey` mono 600 10.5px ls.1em var(--dim); `.envval` 13px var(--fg); `.envval.ok` pill bg var(--ok-bg) bd var(--ok-bd) 11px ls.08em; `.edot` glow; `.seclabel` mono 600 10px ls.12em; `.dangerbtn` radius999 h48; `.statgrid` gap12; `.stat` pad16; `.sl` mono 600 10px ls.12em pb10; `.meter` h6 radius999 + gradient fill.
**Cascade note** (L1857-1858): mobile overrides must sit AFTER desktop declaration of same class (equal specificity, source order wins) — keep that order when rebuilding.

### 2.3 Per view
Common: every page = 2.1 chrome; classes below. `back` hidden field on every POST form = current path+query (sanitized server-side to local path, `//` rejected: L444-447). POST handlers 303-redirect (PRG). Same-origin guard `sameOrigin` L64. No `confirm()`; destructive confirms are inline `<details class="kx"><summary class="ab danger">…</summary><div class="kc">…<form POST><button class="ab danger">Kill It|Delete It|Restart Them</button>` (no-JS disclosures). Only `prompt()` is noVNC paste fallback L841.
Shared components: **`.kx` details + `.kc` popover**: `.kc` abs right0 top42 z9 w250 pad12 gap10 bg var(--pop) 1px var(--bd2) radius16 shadow (L1458); header `.tname` pb10 hairline; `form.af` full-width rows, `.af .ab` left-aligned; `.af.lf` rename row = `span.klbl "Rename"` + `input.li2[name=label maxlength=60]` + `button.ab.ok "Save"`; in `.set` (settings card) `.kc` becomes static (L1488). Phone card `.kc` max-width `calc(100vw - 48px)` z30; `.kx[open]` z31.
Pager `.pg` (L3165, CSS L1621): `nav.pg` > [first][prev] `span.pgnum > span.cur N + span.muted "/ max"` + extra `span.pgtot "<n> total"` [next][last]; links are 32x32 (mobile 40) icon `<a aria-label title>` chevronsLeft/Left/Right/Right else `span.off`.

#### 2.3.1 `/` Sessions (fleet) — `homeView` L3136, `renderFleet` L3117
Query params `q|acct|d|s|page` -> 302 `/history`+qs; `fresh|sys|reclaim` -> 302 `/system`+qs (L4018-4030). Calls `freshen()`, `fleetState()` (tmux live + pane-tail classify, cached 3s L376). `page(..,'sessions', fleetJs=true, liveN=fleet.length)`.
```
h1 > a "mows"                                   (desktop hidden)
div.sect "fleet" b#fleet-count[hidden if 0] input[type=search][data-f=filter] placeholder "filter…" (inline style margin-left8 w120 min-h0 pad 3/8)
p.muted#fleet-empty[hidden if >0] "no live sessions."  (inline pad 8px 4px 16px)
div.fleet-rows#fleet-rows                       (>=701 visible; :empty hides)
  div.li[data-sid][data-state] > div.frow
    div.fr1: span.fli.fli-<state>[data-f=glyph] | span.lb[data-f=label] | span.proj[data-f=proj]
             | span.fact: span.fnum[data-f=num] (1-9) + a.go[data-f=attach][data-nw=t-<name>] ">_" + details.kx[name=fm] (menu) | span.fst[data-f=meta] "<word> <rel>"
    span.fsnip[data-f=snip] (display:none if empty)
div.fleet-cards#fleet-cards                     (<=700 visible)
  div.lp[data-sid][data-state]
    div.lr.fchd (inline justify space-between): span.lb > span.fli.fli-<state>[data-f=glyph] + span[data-f=label] | span.fcact: a.ab.ok[data-f=attach] ">_" (inline font 700 13px mono) + details.kx (menu)
    div.muted (inline 12.5px): span[data-f=proj] " · " span[data-f=meta]
    div.fsnip[data-f=snip] (inline 12.5px; display:none if empty)
<template#fleet-row-tpl> / <template#fleet-card-tpl>  (placeholder row/card, 5023 B on the live page) L3112
a.newcard href=termHref('menu') "+ New Session · open terminal picker"
```
Menu (`fleetMenu` L3069): `details.kx[name=fm] > summary.ab[title="more actions"] ellipsis` + `div.kc`: `div.tname[data-f=tname]` / pause|resume form (`form.af[data-f=pauseform] action=/a/pause|/a/resume`, hidden name[data-f=nameinput]+back, `button.ab(.ok)[data-f=pausebtn]` icon+"Pause"|"Resume") / rename form `/a/label` / `details.kx > summary.ab.danger "Kill"` + `.kc` ("stop <b data-f=killname>?" + muted "the process ends now — the transcript stays on disk, resume anytime." + form `/a/kill` button "Kill It").
**States** (`classifyFleet` L357; order needs-you, working, paused, idle; sort L405): `data-state` in {needs-you, working, paused, idle}; glyph `.fli-<state>` chars needs-you `◉`(25C9) working `●` paused `⏸` idle `○`; colors: needs-you & paused var(--warn), working var(--ok), idle var(--dim) (L1522-1525); status words waiting/working/paused/idle (`FLEET_WORD` L3054) colored by state on `[data-f=meta]` L1613-1615; row glyph shrunk 10px opacity .55. Label = `f.label || f.proj || f.name`. Meta = `<word> <rel>`; `rel()` L1339: <90s `now`, <90m `Nm`, <36h `Nh`, else `Nd`.
Row hover: `.fact` opacity0 (pointer:fine) revealed on hover/focus-within/open menu L1505-1508. Card: whole card is tap target via `[data-f=attach]::after{inset:0}` L1552; `:active` bg var(--card2).
**Refresh**: SSE `GET /events` (named event `fleet`, payload `[{sid8,name,label,proj,state,rel(ms epoch),snippet}]`, server tick 2s, only emits when JSON changed, `: hb` comment every 25s, max 8 clients else 503) consumed by `/fleet.js` (2.4). No polling beyond that; no reload. **Empty**: `#fleet-empty` text; containers hide via `:empty`. **Search**: client-side `[data-f=filter]` (label+proj+snippet substring, lowercase) toggles `style.display`; key `/` focuses it; digits 1-9 click nth row's attach link. **Pagination**: none.

#### 2.3.2 `/history` — `listView` L3175 (`page(..,'history', fleetJs=true, liveN=live.length)`)
Params: `acct` (account id; defaults to host-subdomain account `HOST_ACCT[sub]`), `q` (lowercased, 80 max; matches `proj` or `sid` prefix), `d` (`today|7d|30d`), `s` (`live`), `page`; `?fresh=1` -> 303 bounce `?sys=1`. PAGE=20 rows (L123). Account chips from `ACCTS` (`.dot` account color, count).
```
h1 "mows · history[ · <acct host label>]"
details.sys.flt[open if any filter active]            (L1698, L1735-1750)
  summary > span.syst (svg.search "filter") + span.syss "<acct|all> · <range|all time>[ · live][ · “q”] · <b>N</b>[ of M] sessions"   (::after ▾/▴ chevron)
  div.sysbody
    div.bar: a.chip(.sel) "all <b>N</b>" + a.chip(.sel) [span.dot color] "<acct> <b>n</b>" …
    div.bar: a.chip "all time|today|7 days|30 days" ; a.chip(.on) [span.dot var(--ok)] "live <b>n</b>"
             form[get /history] hidden acct/d/s + div.fsw > span.fico + input[type=search][name=q] placeholder "filter path / id…"
div.hlist  (or p.muted "no sessions match." inline pad 20px 0)
  div.day "today|yesterday|<UTC date>"       (uppercase 12px/700 var(--dimmer) ls .6px mt32)
  div.li > a.row[href=/s/<acct>/<sid>]
        span.t rel | span.acct[style color:<acct.color>] label | span.proj projName | span.ttl [span.lvb>span.lvbd "LIVE"] title|span.notitle "(no title)" | span.sz size | span.sid sid8
     + a.go[data-nw=t-<sid8>] ">_" (live: attach, title "attach (live)"; else resume `termHref('open',sid8)`; only if acct.term && canResume (<=7d idle or live))
     + (if not live) details.kx.del > summary.dx[title "delete transcript"] svg.x + div.kc: "delete <b>sid8</b>?" / span.muted "removes the transcript from disk — no undo." / form.af POST /a/del hidden a,sid,back + button.ab.danger "Delete It"
nav.pg  (+ span.pgtot "<N> total")
```
Rows: `.li` hairline; only the row after `.day` keeps hairline+left rule (L1608); `.go`/`.kx.del` opacity0 until hover on pointer:fine (L1601-1604). Mobile: `.row` wraps (`.ttl` full width order9, `.sz` hidden, `.sid` right) L1658. `.lvb` pill: bg var(--ok-bg) color var(--ok) radius4 12px/500 with 6px pulsing dot. **Refresh**: none (static; full reload / PTR); fleet.js loaded but `hasFleet` false -> no /events. `/` key focuses filter (opens `details.flt`). Empty: "no sessions match.". Disabled-resume: `.go` omitted.

#### 2.3.3 `/s/<acct>/<sid>` (session transcript; linked from history) — `detailView` L3236
`h1 "← sessions"`; `div.meta` (grid auto/1fr: session [LIVE pill], account (color), project, started, last, size); `.la`: `a.btn[data-nw] ">_ attach — live now|attach — paused|open in terminal"` + (live) `actForms()` L1345 (pause/resume form, `details.kx[name=am]` pencil rename `.kc`, `details.kx[name=am]` Kill); or muted "resume disabled — idle …"; `div.note` "large transcript — showing the most recent 8MB window."; `nav.pg` ×2 (MSG_PAGE=25, newest page first, extra "<n> items · newest first"); messages: `div.m.user|claude > div.mh > b who + " · HH:MM:SS"` + `pre` (or `details > summary(first 200 chars…) + pre` if >2500 chars); tool = `details > summary svg.wrench name + pre`; `↳ result`, `⟲ compaction summary` details. `.m` border-left 3px user #60a5fa / claude var(--ok). Static; no JS.

#### 2.3.4 `/system` — `systemView` L3148 -> `sysPanel(..., flat=true)` L1151 (`page(..,'system', fleetJs=false)`)
Params: `?reclaim=1` (runs `reclaimScan()` ~1-2s du), `?fresh=1` (303 `bounceFresh`: `usage(true)` + `sys=1`), `freed`,`rn` (flash chip), `rs` (restart count chip). Head `<meta http-equiv=refresh content=4>` while `usageCache.busy`.
```
h1 "mows · system"
div.sysview
  div.sysgrid                                  (desktop grid 464px 464px gap96; mobile block)
    section.sysleft
      div.sechead > h2 "Metrics" + p "Live utilization of host resources."
      div.mbars  (mobile: 2x2 grid)
        div.mbar ×4: Load average (`<load> / <cores> cores`, warn if load>cores) | Memory (`x / y G`, warn >85%) | Swap (`not configured` if 0) | Disk / (warn >85%)
          div.mbar-row > span.mbar-label + b.mbar-pct "NN%"(phone only) + span.mbar-val
          div.mbar-track > div.mbar-fill[.warn][style width:NN%]
    div.sysright
      section.sysright-item (no CSS rule)
        div.sechead > h2 "Environment" + p "System configuration and status."
        div.envcard > div.envrows: .envrow(.envkey+.envval[.ok] span.edot "ONLINE") STATUS | VERSION (claudeVersion) | div.envdiv | UPTIME "Nd Nh" | LAST_DEPLOY (span[title abs]) | div.envdiv | NODE process.version | OS platform/arch
      section.sysright-item
        div.sechead > h2 "Terminal" + p "Master process and theming."
        div.termcard.set > div.seclabel "Master process" + [live>0: details.kx > summary.dangerbtn svg+"Restart All Sessions (N)" + div.kc "restart all <b>N</b> live session(s)?" / span.muted "whatever is running right now is killed — including the session you are reading this from." / form.af POST /a/restartall hidden back=/system + button.ab.danger "Restart Them"] | [0 live: div.dangerbtn.off aria-disabled "restart all sessions"]
          + p.dangercap + [span.chip.on > span.dot "restarted N"]
  div.sysextra
    div.sechead > h2 "Usage & Reclaim" + p "Claude account limits, daily spend, and disk reclaim."
    div.bar: span.chip "usage updated <b>age</b>[ · refreshing…]" + a.chip[href=/system?fresh=1] svg.refresh "Refresh" + a.chip[href=/system?reclaim=1 | /system] (svg.trash "Reclaim" | svg.x "Close") + [span.chip.ok "reclaimed <b>size</b> · n target(s)"]
    (if ?reclaim) div.statgrid > div.stat.wide: span.sl "reclaim · measured just now" + form.rf POST /sys/reclaim hidden back + label.rrow×N (input[checkbox name=t value=id, checked unless guarded]+span.rl+b size+span.muted note) + div.rrow.tot (span.rl "checked by default" + b + button.ab.danger svg.trash "Reclaim Selected") + div.mlist.muted
    div.statgrid.u > per account: div.stat (span.sl "<acct> · limits" + div.qrow×2 [5h, week: span+span.meter>i+b %] + div.mlist.muted) + div.stat (span.sl "<acct> · spend" + qrow today/week/month + 5h block + div.mlist models + details.ubd "full breakdown · 7 days" per-day qrow + sessions `a.sid8`)  | or p.muted "collecting usage — first pass takes ~15 s, refresh in a moment…"
```
Meter color: <50% var(--ok), >=50% var(--warn), >= hot (90) var(--bad) (L1154). Warn colors for mbars are flat: desktop `.mbar-fill` bg var(--fg), `.warn` #fef3c6; phone gradients. Non-flat variant (collapsible `details.sys`, "📊 system" summary + `.statgrid` 5 stats) exists in `sysPanel` but no current route renders it (L1268; only `flat=true` caller is systemView) — not verified whether anything else calls `sysPanel`.
**Refresh**: meta refresh 4s only while usage collecting; otherwise static. Confirms: restartall `<details>`; reclaim = checkbox form (no extra confirm). Errors: absent tools degrade to "?" / "ccusage not installed — sudo npm i -g ccusage" / "oauth token expired …".

#### 2.3.5 `/device` — `deviceView` L861 (`page(..,'device')`; bodyClass `watchlive` if live)
Params `dv=mobile|web` (default: mobile if droid not stopped, else web if noVNC up, else mobile). `head` meta refresh 4s while droid `booting`. droid state via `docker inspect redroid` + `adb getprop sys.boot_completed` + `wm size` (L684); noVNC liveness = TCP probe :6080 cached 3s (L576).
```
h1 "mows · device"
div.devlayout                              (flex row gap48; mobile column gap24)
  aside.devrail                            (w320; mobile 100%)
    div.segtoggle > a.segbtn(.on)[href=/device?dv=mobile] svg.smartphone "Mobile" + a.segbtn[href=/device?dv=web] svg.monitor "Web"
    div.devcard (info): div.devhead > div(div.devname "Android Emulator"|"QA Browser" + div.devsub "redroid · 127.0.0.1:6555"|"Xvfb :99 · Chrome (noVNC)") + [span.lvb2 > i + "LIVE"]
                        div.devrows > div.devrow(span key + span value[.good]) STATE RUNNING|BOOTING|STOPPED | RESOLUTION | TARGET   (web: STATE LIVE|IDLE, PORT 6080)
    div.devcard (controls): div.ctlhead "Emulator"|"Browser" + div.ctlgrid (2 cols)
        mobile: form.af.ctlform POST /droid/stop|/droid/start > button.ctlbtn.wide.danger|.ok "Stop Emulator"|"Start Emulator" ; a.ctlbtn /device?dv=mobile "Refresh" ; a.ctlbtn[href=/droidview/ target=_blank rel=noopener] svg.cast "Console" ; p.dangercap (help text with <a> to terminal + adb/maestro commands)
        web:    form POST /watch/stop|/watch/start button.ctlbtn.wide "Stop Browser"|"Start Browser" ; a.ctlbtn.wide /device?dv=web "Refresh" ; p.dangercap
    [web+live] div.devcard "Remote keys": div.ctlgrid.icons4 > 8× button.ctlbtn[type=button][onclick] keyboard kb(), clipboard pst(), chevronUp PageUp, chevronDown PageDown, arrowLeft nav(1), arrowLeft.icoflip nav(0), refresh F5, square Escape
  div.devstage[.live]   (flex1 min-h600 radius24 dashed 1px var(--bd) bg rgba(24,24,27,.2))
    [fill only] button.fsbtn[onclick toggles body.devfs] svg.maximize
    stage content:
      mobile live desktop: iframe.vnc[title "Android emulator (redroid remote view)"][src=/droidview/#!action=stream&udid=…&player=tinyh264&fitToScreen=true&ws=wss://<host>/droidview/?action=proxy-adb…]
      mobile live phone UA (iPhone|iPad|iPod|Android|Mobile|Silk): div.stageempty > a.ctlbtn.ok.stagecta svg.play "Open Screen (full page)" + p.stagecap
      web live: iframe#vf.vnc[src=/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&quality=9&compression=6&path=vnc/websockify][allow=clipboard-read;clipboard-write]
      not live: div.stageempty > div.stageicon(svg 28px) + div.stagemsg "Awaiting stream…" + p.stagecap (copy differs: stopped/booting/browser idle)
  [web+live] <script> remoteKeysScript (1486 B) L832
```
Full-screen: `body.devfs` CSS-only: stage `position:fixed;inset:0;z80` bg #000, hides `.tabs`/`.termfab` L1842-1845. `.ctlbtn` 38px h radius12 bg rgba(24,24,27,.4) 1px var(--bd2) mono? no: sans 500 12px color var(--mut); `.ok`/`.danger` text colors; `.wide` spans 2 cols; `.icons4` 4 cols. `.segbtn` pad 10/0 radius8 500 12px, `.on` bg var(--pop). Cards bg var(--card) 1px var(--bd) radius16 pad20. States: stopped/booting/live (droid), idle/live (browser). Refresh: meta refresh 4s only while booting; otherwise manual "Refresh" links. Old `/watch|/droid|/settings` 302 -> `/device` L3974. `/droid/touchtest` L3977 = standalone diagnostic page (TOUCHTEST L645), not part of shell.

#### 2.3.6 `/agents`, `/agents/<name>`, `/agents/<name>/<run>` (server-rendered twins; nav Agents tab points to SPA `/ui/agents` instead)
`agentsView` L3385 (served in 1.37 s: shells `mows-agent residents --json`, timeout 20 s `RESIDENTS_TIMEOUT_MS` L3384; `agentsIndex()` 3 s cache L3300). `page(..,'agents')`.
```
/agents:  h1 "mows · agents"
  a.agent.card[href=/agents/<n>] > b name + span.pill.st-<state> + span.muted "<rel> · <N> runs · 7d $x.xx"   (or p.muted "No agents yet. <code>install.sh --agents</code> …")
  details > summary "Native background sessions (N)" | "… — poll failed" > ul > li (b name + pill + span.muted "profile · waitingFor · cwd")
/agents/<n>: (agentDetailView L3522)
  h1 "← agents · <n>" ; p > pill + span.muted "7d $ · N runs · Next: <timer label>"
  div.actions > form POST /a/agent-run button "Run now" ; /a/agent-pause|resume (both if timers 'mixed') ; /a/agent-stop only if last state 'working'   (hidden name, back)
  h2 "Chat" > div.m.me|claude > div.mh(b you|<n> + span.muted time[ · $cost]) + pre ; p.muted "No messages yet. …" ; p.muted "Thinking… reload in a few seconds." if last turn is user ;
        form.chatf POST /a/agent-chat (hidden name, back) textarea[name=msg rows=2 required placeholder "Ask <n> about its last run…"] + button "Send"
  h2 "Runs" > ul.runs > li > a[data-norun href=/agents/<n>/<run>] run_id + pill + span.muted "$ · N turns · N tools"
  h2 "Events" > pre.events (last 5 lines of events.log)
/agents/<n>/<run>: (agentRunView L3557) h1 "← <n> · <run>" ; pre.status JSON(status.json) ; div.m.claude > div.mh b claude + pre (assistant text from stream.jsonl)
```
States: pill classes `st-working` (#2563eb33), `st-done` (#16a34a33), `st-failed|stalled|budget_exceeded` (#dc262633), `st-never` (#71717a33); `st-blocked` appears in markup with no rule. Pill `.pill` pad 1/6 radius9 .75em. Sorting: working first, bad (stalled/failed/budget_exceeded) next, then by last event desc (L3321). Crash detection: `working` with dead pid -> `failed`. Chat is non-streaming on this twin (POST->303, answer visible on reload); streaming exists only in /ui (SSE `/stream`; other mapper). Static, no JS, no refresh. 404 plain `res.writeHead(404)` (no page chrome) for bad name/run. Cap 40 chat turns (CHAT_MAX L3413). Webhook `/wh/<name>` is HMAC, no UI.
Agent SPA CSS (`.agwrap .ag2 .agchat .agh .agav .chatbox .agside .cl .cchip .rruns …` L1935-2105) lives in the same shared stylesheet but is used only by `/ui` — not mapped here (see SPA mapper).

#### 2.3.7 `/md?f=<abs path>` — `mdView` L2360
Rules: path must start `/`, end `.md|.markdown|.txt`, realpath under `/home`, regular file <=2 MB, else `oops()` = `page('markdown', h1 a "mows" + p msg + p a "← sessions")` with 400/403/404 (L2362). `&dl=1` returns raw file `Content-Disposition: attachment; filename*=UTF-8''…`, `text/markdown`, `no-store` (L2371). Server-side renderer `mdHtml` L2311 (escapes whole source first; headings, fenced code `pre[data-lang]`, one-level lists + `li.task` disabled checkbox, quotes, tables in `.mdtbl`, hr, inline code/strong/em/del/links/images/autolink; `safeUrl` scheme allowlist; relative links rewritten to `/md?f=`). Page `page(…, head=<style>MD_CSS</style>[+MD_MERMAID], tab='')`.
```
h1 > a "mows"
div.mdhead > b basename + span abs path + span "<KB> · updated <rel> ago|just now" + a.mddl[href=/md?f=…&dl=1 download] "⬇ Download" (margin-left:auto)
article.mdv > rendered HTML (h1-h6, p, ul/ol, pre>code, blockquote, hr, div.mdtbl>table, img, a)
```
`MD_CSS` (L2232-2257, 1994 B, NOT comment-stripped): `.mdv` lh1.65 color var(--fg2) pb24; h1 23px/h2 18px with bottom borders, h3 15.5px; pre bg var(--card2) 1px var(--bd2) radius var(--r) pad 12/14 scroll-x, `pre[data-lang]::after` language label top6 right10 11px mono var(--dimmer); `blockquote` left 3px var(--ok-bd); `code` 12.5px mono bg var(--pop) pad 2/5 radius5; tables 13.5px 1px var(--bd2) cells pad 6/10, th bg var(--card2); links var(--ok); `.mdmmd` (mermaid) scroll-x center cursor zoom-in, `.full` zoom-out left. Mermaid only when a `data-lang="mermaid"` fence exists (L2265). Static; no refresh.

### 2.4 Client JS inlined
| script | where | bytes (served) | does |
|---|---|---|---|
| `speculationrules` JSON | every page L2453 | 272 | prerender rules (2.1) |
| base inline `<script>` | every page L2456-2553 | 6834 | SW register; busy-form; data-nw targets; #envout diag + `/z` beacon; vpfix; PTR (details below) |
| `/fleet.js` | `/` and `/history` via `<script defer src=/fleet.js>` L2553; `FLEET_JS` L2892-3031 | 8870 raw / 3742 gz-9 (served `cache-control: public, max-age=300` + crc32 etag, L3927) | live fleet SSE island + keyboard |
| `remoteKeysScript` | `/device?dv=web` only when noVNC live, L832-845 | 1486 (source lines) | `kb/pst/k/nav` helpers, polls 1200 ms to import `./app/ui.js` into the same-origin `#vf` iframe to grab `window.rfb` (`_x`), `sendKey`; clipboard read -> `rfb.clipboardPasteFrom` then Ctrl+V after 90 ms; `prompt()` fallback |
| mermaid loader `<script type=module>` | `/md` pages with a mermaid fence, L2265-2279 | ~802 | imports `https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.esm.min.mjs` (CDN, major-pinned, not vendored), `initialize({startOnLoad:false, theme:'dark', securityLevel:'strict'})`, renders each `.mdv pre[data-lang=mermaid]` -> `div.mdmmd` SVG; click toggles `.full` (natural width vs fitted `max-width:<viewBox w>`); on parse error keeps source, sets `pre.title` |
| inline `onclick` | `/device` | n/a | `document.body.classList.toggle('devfs')` (fsbtn); remote-key buttons call `kb()/pst()/k()/nav()` |
| `<meta http-equiv=refresh content=4>` | `/device` (booting), `/system` (usage busy) | n/a | only auto-reload mechanism besides SSE |
**/fleet.js internals** (L2892-3031): IIFE strict. `hasFleet = #fleet-rows && #fleet-cards && EventSource`; keydown handler runs on every page that loads the file. GLYPH/WORD maps mirror server (`◉ ● ⏸ ○`; waiting/working/paused/idle). `connect()`: `new EventSource('/events')`, listener for event `fleet` -> `render(JSON.parse(data))`; `onerror`: close, reconnect after `retry + rand*400` ms, retry doubles 1000 -> max 30000, reset to 1000 on message. `render(list)`: for each fleet item look up `[data-sid="<sid8>"]` in BOTH `#fleet-rows` and `#fleet-cards`; `patch(node,f)` if present else `instantiate()` = clone of `<template id=fleet-row-tpl|fleet-card-tpl>.content.firstElementChild` then patch; `appendChild(node)` (re-attaching MOVES = reorder, no rebuild); remove nodes whose sid is absent; toggle `#fleet-empty[hidden]`, `#fleet-count` text+hidden, `#pnav-live` text+hidden; `updateNums()` rewrites `[data-f=num]` 1-9; `applyFilter()`. `patch` writes data-sid/state/mt dataset, `[data-f=glyph]` class+char, `label` (`label||proj||name`), `proj`, `meta` (`<word> <relStr>`), `snip` (text + display), `attach` href (`/term/?arg=attach&arg=<name>&arg=<fresh crypto tabid>&v=3`, `data-nw=t-<name>`), `nameinput`/`tname`/`killname`/`labelinput`, and pause<->resume form swap (`action` `/a/resume|/a/pause`, button class `ab ok|ab`, innerHTML icon+label inlined from ICO). `setInterval(tick,30000)` re-renders relative time from `dataset.mt`. Keys: 1-9 -> `.click()` on nth row `[data-f=attach]` (ignored in INPUT/TEXTAREA/contentEditable or with alt/ctrl/meta); `/` -> focus `[data-f=filter]`, else on `/history` opens `details.flt` and focuses/selects `input[name=q]`.
**Base script detail**: PTR (L2531-2553) only when `display-mode:standalone && 'ontouchstart' in window`: appends `div#ptr` (svg refresh 16px); passive touchstart arms if `scrollY<=0`; touchmove pull>8 -> p=min(pull/2,72), `translate(-50%,p px) rotate(p*3 deg)`, opacity min(p/56,1), class `go` when p>=56; touchend: `go` -> add `spin` + `location.reload()` else reset. Never preventDefault. `#ptr` CSS L1589-1595 (36px circle, bg var(--pop), z25, `#ptr.go` color var(--ok), `.spin svg` ptrspin .7s linear infinite).
**Card menu behavior**: plain `<details>`; exclusive via `name="fm"` (browser details-group, fleet menu) and `name="am"` (session-detail rename/kill); no JS; `details[open]>*:not(summary)` pop-in animation .18s (L1884-1890). Tap-to-toggle only exists in the mermaid block.
**noVNC loader**: iframe `/vnc/vnc.html?…` (same origin via Caddy `/vnc/*` -> :6080) + `_x()` interval above (clears once `window.rfb` found). Android stream is a ws-scrcpy iframe at `/droidview/` (no loader JS here).

### 2.5 PWA bits
- Manifest `GET /manifest.webmanifest` (`manifest()` L2704; `crossorigin=use-credentials` link): `id:"/"`, `name:"mows sessions"` (per-account hosts: `mows · <label>`, `short_name:<label>` via `hostAcct`), `short_name:"mows"`, `start_url:"/app"` (302 -> `/term/?arg=attach|open…&v=3` or `/term/?v=3`, `appView` L2613), `scope:"/"`, `display:"standalone"`, `background_color:"#09090b"`, `theme_color:"#09090b"`, `description:"mows harness: agent sessions, web terminal, QA watch, android console"`, icons `/icon-192.png` 192, `/icon-512.png` 512, same 512 again with `purpose:"maskable"`. Served JSON 460 B (verified). No `orientation` (comment: rotate for landscape).
- Icons generated at runtime by `iconPNG(size,color)` L2674 (zero-dep PNG: bg #09090b, `>_` glyph, 3x3 supersampled, color = account color else #00d492, cached): `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` (180), `/favicon.png` & `/favicon.ico` (48); `cache-control: public, max-age=86400` (L4041-4048).
- Service worker `/sw.js` (`SW` L2720, 844 B): `install -> skipWaiting`, `activate -> clients.claim`, `fetch`: only `request.mode==='navigate'` -> `fetch()` passthrough, on failure returns inline offline page (bg #09090b, `>_` in #00d492 26px, "offline — the console needs a connection.", `retry` link `/`). **No caching** (ponytail comment L2718). Registered at L2456 on every server-rendered page (not on `/ui` shell: its own head has no register — not verified in app/main.mjs).
- Apple: `apple-mobile-web-app-capable=yes`, `status-bar-style=black-translucent`, `mobile-web-app-capable=yes`, `apple-touch-icon`. Viewport locks zoom (`maximum-scale=1,user-scalable=no`) because without it iOS standalone letterboxes (L2606-2610 comment). `theme-color #09090b`, `color-scheme dark`.
- Install hints: none in UI (no install prompt/button). Standalone-only code paths: PTR, vpfix, top-anchored tabs/FAB, `data-nw` window naming disabled, `#envout` shows `app|tab`.

### 2.6 Byte sizes (live fetch 2026-10-11 from 127.0.0.1:3005; raw/gzip-9/brotli-11 via node zlib; "served gz" = origin's actual `content-length` with `accept-encoding: gzip`, default gzip level; origin sends no brotli)
| path | raw | gz-9 | br-11 | served gz | `<style>` blocks/bytes | `<script>` blocks/bytes (incl. speculation) | inline `style=""` attrs |
|---|---|---|---|---|---|---|---|
| `/` | 79128 | 15953 | 13845 | 15589 | 1 / 46753 | 3 (spec 272 + base 6834 + `fleet.js` ext) = 7106 | 21 |
| `/history` | 86072 | 17325 | 14874 | 17377 | 1 / 46753 | 3 / 7106 (+fleet.js ext) | 28 |
| `/history?acct=…&d=7d&q=mows` | 62762 | 15474 | 13547 | n/a | 1 / 46753 | 3 / 7106 | 9 |
| `/system` | 64508 | 15929 | 13940 | 15967 | 1 / 46753 | 2 / 7106 | 21 |
| `/system?reclaim=1` | 66041 | 16343 | 14283 | n/a | 1 / 46753 | 2 / 7106 | 21 |
| `/device` (mobile) | 60636 | 15130 | 13196 | 15170 | 1 / 46753 | 2 / 7106 | 0 |
| `/device?dv=web` (idle) | 60151 | 14998 | 13082 | n/a | 1 / 46753 | 2 / 7106 | 0 |
| `/agents` (1.37 s) | 58939 | 14669 | 12831 | 14704 | 1 / 46753 | 2 / 7106 | 0 |
| `/agents/<agent>` | 143136 | 29771 | 25313 | 29845 | 1 / 46753 | 2 / 7106 | 0 |
| `/agents/<agent>/<run>` | 63770 | 16959 | 14778 | 16999 | 1 / 46753 | 2 / 7106 | 0 |
| `/md?f=…/ATTRIBUTIONS.md` | 118042 | 35034 | 30362 | 17499 | 2 / 48747 | 2 / 7106 | 0 |
| `/md?f=…/README.md` (has mermaid) | 103983 | 29814 | 25852 | n/a | 2 / 48747 | 3 / 7908 (+mermaid module 802) | 0 |
| `/s/<acct>/<sid>` | 87900 | 23505 | 20523 | 19667 | 1 / 46753 | 2 / 7106 | 2 |
| `/ui/agents` (SPA shell, ref) | 50964 | 11479 | 10113 | n/a | 1 / 46753 | importmap 640 + module src | 0 |
| `/fleet.js` | 8870 | 3742 | 3166 | (no gzip applied; `public,max-age=300`) | | | |
| `/manifest.webmanifest` | 460 | 256 | 205 | | | | |
| `/sw.js` | 844 | 550 | 373 | | | | |
| fonts (immutable) | Inter 48256, JetBrains Mono 31432 | | | | | | |
Notes: the single `<style>` is `cssText()` = CSS const (L1358-2217, 70136 B source incl. comments — V3-corrected) minus comments/blank lines = 46753 B served; second `<style>` on `/md` = `MD_CSS` 1994 B (source L2232-2263 is 2541 B incl. the const line). The CSS + base script (~53.6 KB of inline) ship in EVERY page and can never 304 (no-cache, per-response HTML). `/` carries 5023 B of `<template>` markup. Raw sizes of the 'sessions' page vary with fleet size/history length; this snapshot had 3 live sessions, 366 indexed.

### 2.7 Not verified / gaps
- No browser rendering done: no screenshots or computed-style diff; all geometry is from CSS text. Visual parity numbers (e.g. mobile 22px cards) are source-derived.
- Whether an open `/events` EventSource blocks bfcache restore; actual bfcache/prerender hit rates.
- Caddy/front-proxy behavior (brotli re-encode, gauth/oauth2 headers, `/term`, `/vnc`, `/droidview`, `/oauth2/sign_out` routes) is outside lite.mjs.
- `/ui` SPA internals (app/main.mjs, store.mjs, views/*, `--kb` handler, `html.agent-view`/`kb-open` setters, SW registration in the SPA shell, `.ag2`/`.chat` markup) — belongs to the SPA mapper; only chrome + shared CSS referenced here.
- The non-flat `sysPanel` (collapsible `details.sys`, "📊 system") is dead for current routes as far as read; not exhaustively grepped for other callers.
- Live-state variants not exercised on the live box: noVNC-up `/device?dv=web` (remote-keys card + `#vf`), droid `live`/`booting` stages, `/system` reclaim result flash + usage cards with real data, `needs-you`/`paused` cards, history with LIVE rows, mermaid render. Their markup is from source only.
- Per-account hosts (`HOST_ACCT[sub]`): affects history default filter, h1 label, manifest name/short_name and icon tint; account list/colors come from `discoverAccounts()` at runtime (L95) — values not enumerated here.
- `st-blocked` pill class is emitted by the agents views with no CSS rule; `.sysright-item`, `.sysview` have no rules (verified by class-vs-CSS diff across 15 served pages).
- Fleet sorting/snippet derivation (`tailOf`, `FLEET_RE` L340) and `titleOf` title extraction are server logic, not mapped.
- Accessibility: focus ring = `:is(a,button,summary,input):focus-visible{outline:2px solid var(--ring);offset 2px;radius6}` L1396; summary variant ok-bd L1746; touch: `touch-action:manipulation`, `-webkit-tap-highlight-color:transparent` — screen-reader labels exist only as aria-label on icon links (cited inline in markup); no landmarks audit done.


## 3. /ui app

Citation convention. `app/…` = `infra/dashboard/app/…`, read live. `lite.mjs:N` = line in a snapshot of `infra/dashboard/lite.mjs` taken 2026-10-11 02:10 UTC (4101 lines, sha256 891e525a…). [V1b: the committed file IS this snapshot (4101 lines, same sha), so no offset applies — every lite.mjs line below is valid as written; the mapper had briefly seen the pre-drift 4009-line repo copy.] Snapshot: `scratchpad/map/lite.snap.mjs`. Functions are named so they can be re-found.

### 3.1 Files and sizes
Columns: raw, gzip -9 (zlib level 9), brotli (default) bytes. Measured with the supplied node one-liner.
| id | file | raw | gzip | brotli | role | cited |
| U-01 | app/main.mjs | 2582 | 1188 | 961 | entry: router, click/popstate, View Transition wrapper, mounts `<App>` | app/main.mjs:1-47 |
| U-02 | app/store.mjs | 1899 | 1022 | 835 | single EventSource, topic pub/sub, `getJSON`, unused `state` object | app/store.mjs:1-34 |
| U-03 | app/ui.mjs | 566 | 307 | 266 | `html` (htm bound to h), `usd`, `rel`, `Pill` | app/ui.mjs:1-13 |
| U-04 | app/views/agents.mjs | 11096 | 4592 | 3834 | `AgentsList`, `AgentDetail`, telemetry/capability summary | app/views/agents.mjs:7,97 |
| U-05 | app/views/capability.mjs | 12780 | 5106 | 4241 | `CapabilityPanel` (text-node-only render of the policy report) | app/views/capability.mjs:47 |
| U-06 | app/views/chat.mjs | 32523 | 12954 | 10990 | `Chat`, `renderPartial`, `reconcile`, `safeHref`, tokenizer/renderer overrides | app/views/chat.mjs:26-486 |
| U-07 | app/views/runs.mjs | 839 | 471 | 411 | `RunView` | app/views/runs.mjs:5-15 |
| U-08 | app/vendor/preact.mjs | 11429 | 4683 | 4294 | vendored preact (minified) | not verified (version unstated in file; head read) |
| U-09 | app/vendor/hooks.mjs | 3729 | 1564 | 1428 | vendored preact/hooks | not verified (version) |
| U-10 | app/vendor/htm.mjs | 1207 | 652 | 577 | vendored htm | not verified (version) |
| U-11 | app/vendor/marked.mjs | 92829 | 18351 | 16102 | vendored marked v14.1.3 | app/vendor/marked.mjs:2 |
| U-12 | app/vendor/inter-var-latin.woff2 | 48256 | 48254 | 48260 | variable face, weights 400-700 | lite.mjs:1378-1379 |
| U-13 | app/vendor/jetbrains-mono-var-latin.woff2 | 31432 | 31460 | 31436 | variable face, weights 400-700 | lite.mjs:1380-1381 |
| U-14 | app/vendor/SHA256SUMS | 489 | 321 | 313 | pins for U-08..U-13; not served (no `.sums` entry in UI_ASSET_TYPES) | lite.mjs:3722-3726; `sha256sum -c` run: all 6 OK |
| U-15 | (sum U-01..U-13, served set) | 251167 | 130604 | not measured | by hand from rows above | arithmetic |
| U-16 | client-asset ceiling | - | 158720 | - | preflight gate: gzip -9 of every `*.mjs *.css *.woff2` under app/ <= 158720 B; comment says fonts = 79709 B of it | scripts/preflight.sh:123-152 |
| U-17 | companion server files (outside app/) | capability.mjs 16587; chat-stream.mjs 1632 | - | - | `agentCapability()` builds the `capability` JSON; `wireChatStream()` turns child stdout into delta/end | infra/dashboard/capability.mjs:87; infra/dashboard/chat-stream.mjs:6 |
| U-18 | inline CSS in shell | not measured | - | - | `cssText()` = module-level `CSS` literal (starts lite.mjs:1358) with comments stripped, blank lines collapsed, font placeholders substituted; shared with server-rendered pages; comment states 22 KB raw / ~10 KB gz before strip | lite.mjs:3752-3761 |

Served extensions: `mjs`, `css`, `woff2` only (lite.mjs:3722-3726). No `.css` file exists under app/ (ls).

### 3.2 Routes the SPA owns (client router)
Router is a regex chain in `route(path)`; state is `useState(location.pathname)` and a custom `route` window event.
| id | path pattern | component | file:line |
| R-01 | `^/ui/agents/([^/]+)/([^/]+)$` | `RunView name run` | app/main.mjs:33 |
| R-02 | `^/ui/agents/([^/]+)$` | `AgentDetail name` | app/main.mjs:34 |
| R-03 | everything else (incl. `/ui`, `/ui/`, `/ui/system`, trailing-slash variants of R-01/R-02) | `AgentsList` | app/main.mjs:35 |
| R-04 | link interception: `a[href^="/ui"]`, skipped when meta/ctrl/shift or `a.target` set | `navigate()` -> `pushState` + `route` event | app/main.mjs:15-19 |
| R-05 | back/forward | `popstate` -> `route` event | app/main.mjs:29 |
| R-06 | same-document View Transition around navigation when `document.startViewTransition` exists | - | app/main.mjs:10-14 |
| R-07 | scroll: `scrollByPath` Map saved in `navigate()` only; restored in `requestAnimationFrame` after `route`; file's own TODO says popstate does not save the outgoing path | - | app/main.mjs:9,12,21-28,40 |

Server side of the same paths: `p === '/ui' || p.startsWith('/ui/')` -> `uiView` for any path (lite.mjs:3897, router in `http.createServer`); `/ui/assets/*` checked first (lite.mjs:3896). `uiTwinPath` maps `/ui/agents/<n>[/<run>]` (trailing slash tolerated, AGENT_RE/RUN_RE-validated) to `/agents/...`, else `/agents`, for the `<noscript>` link (lite.mjs:3823-3829). Server-side match accepts trailing slash; client R-01/R-02 do not.

### 3.3 Server endpoints the SPA consumes
All handlers in `apiView` (lite.mjs:3462) unless noted. `apiView` does not inspect `req.method`. JSON via `sendJson` -> `send` (gzips when body >1024 B and Accept-Encoding has gzip; `cache-control: no-cache`) (lite.mjs:3459-3461, 2577-2590). `AGENT_RE=/^[a-z0-9][a-z0-9-]{0,63}$/`, `RUN_RE=/^\d{8}-\d{6}-\d+$/` (lite.mjs:3296-3297).
| id | endpoint | method | handler file:line | response shape (keys) | consumed by file:line |
| E-01 | `/api/agents` | GET | lite.mjs:3472-3481 | `{agents:[{name,state,last_event_at,total,cost7d}]}` (sorted working, bad, other; then last_event_at desc, lite.mjs:3320-3322) | app/views/agents.mjs:11 |
| E-02 | `/api/agents/<name>` | GET | lite.mjs:3485-3504 | `{name,recs[],events[],total,cost7d,timers,timer,capability,memory}`; `recs[]` = each run's status.json fields + `run_id`, newest first, max 20 (lite.mjs:3304-3311); `events` = last 5 lines of events.log (lite.mjs:3317); `capability` null if frontmatter unreadable; `memory` null if no memory.md | app/views/agents.mjs:99 (reads `recs[0].state`, `capability.policy.model`, `capability.effective`, `capability.policy`, `capability.authorities[0]`, `cost7d`, `events`, `memory`) |
| E-03 | `/api/agents/<name>/chat` | GET | lite.mjs:3505 -> `agentChat` lite.mjs:3414-3420 | `{turns:[{at,role,text,cost_usd?}]}`, newest `CHAT_MAX=40` (lite.mjs:3413) | app/views/chat.mjs:292 (mount), :333 (after `chatend`) |
| E-04 | `/api/agents/<name>/runs/<run_id>` | GET | lite.mjs:3506-3519 | `{status, text}`; `status` = status.json; `text` = concatenated assistant text blocks from stream.jsonl; 404 if status.json unreadable | app/views/runs.mjs:7 (reads `status.state`, `status.cost_usd`, `status.turns`, `text`) |
| E-05 | `/a/agent-chat` | POST (form-urlencoded: `name`,`back`,`msg`) | `agentAction` lite.mjs:3580; routed at lite.mjs:3926 (`p.startsWith('/a/agent-')`). Needs POST (405), `sameOrigin` (403), valid name (400), non-empty msg <=4000 chars (400). Spawns detached `mows-agent chat <name> --stream`, answers `303 location: back` | 303 (fetch follows to `back`); body unused | app/views/chat.mjs:425-431 (`fetch`, non-2xx throws) |
| E-06 | `/a/agent-run` | POST (HTML form, full navigation) | lite.mjs:3624-3629 (409 if unit missing) then `303 -> back` | redirect | app/views/agents.mjs:129-133 (`back=/ui/agents/<name>`) |
| E-07 | `/stream?topics=` | GET (SSE) | `streamView` lite.mjs:2827 | see 3.4 | app/store.mjs:25 |
| E-08 | `/ui/assets/<path>.<crc32hex>.<ext>` | GET | `uiAssetView` lite.mjs:3877-3885 | file bytes; 404 unknown; `If-None-Match` equal -> 304; else 200 `content-type`, `etag`, `cache-control: public, max-age=31536000, immutable`, `content-length`; no `content-encoding` is set and no Accept-Encoding check exists in this function | module graph via import map (3.7) |
| E-09 | `/manifest.webmanifest` | GET | `manifest()` lite.mjs:2704 | PWA manifest | `<link rel=manifest crossorigin=use-credentials>` lite.mjs:3859 |
| E-10 | tab-bar / header links (`/`, `/history`, `/system`, `/device`, terminal) | GET, full navigation | `pageChrome` lite.mjs:2419 | server-rendered pages | shell chrome lite.mjs:3855; only `a[href^="/ui"]` is intercepted (app/main.mjs:16) |
| E-11 | `/sw.js` | GET | lite.mjs:4040 (`SW` const: skipWaiting, clients.claim, navigate-only offline fallback; no caching) | JS | registered only by the inline script in `page()` (lite.mjs:2456); `uiShellHtml` contains no `serviceWorker` text (lite.mjs:3830-3868) |

### 3.4 /stream contract
Server: `streamView` lite.mjs:2827-2882 (snapshot). Client: app/store.mjs:19-29.
- Subscription: `GET /stream?topics=a,b` comma list, trimmed, empties dropped, default `fleet` (lite.mjs:2829-2830). Topic names in use by the SPA: `agents` (app/views/agents.mjs:10), `agents` + `chat:<name>` (app/views/chat.mjs:293). Topic `fleet` is accepted server-side (lite.mjs:2867) and registered as an event name client-side (app/store.mjs:26); no SPA view calls `connect(['fleet'])` or `subscribe('fleet')` (grep of app/).
- Headers: `200 text/event-stream`, `cache-control: no-store`, `connection: keep-alive`, then `res.flushHeaders()` (lite.mjs:2831-2838).
- Events (name -> payload keys):
  - `fleet` -> array of `{sid8,name,label,proj,state,rel,snippet}` (`fleetEventPayload`, lite.mjs:2734-2737); sent when JSON string differs from previous (lite.mjs:2867-2870).
  - `agents` -> array of `{name,state,last_event_at,total,cost7d}` full snapshot; sent on change (lite.mjs:2871-2875).
  - `chat` -> `{agent,turn,seq,delta}`, topic `chat:<agent>` (lite.mjs:2812-2816).
  - `chatend` -> `{agent,turn,...summary}` where summary = `{cost_usd,is_error}` from the child's `end` line, or `{closed:true}` fallback (lite.mjs:2819-2826, 3608-3616).
- `id:` field: written only when `streamWrite` is given an id; only `chat` events carry one, format `<agent>:<turn>:<seq>` (lite.mjs:2815, 2802-2805). `fleet`, `agents`, `chatend` carry no id.
- Last-Event-ID: header read at lite.mjs:2847; split on `:` into `agent,turn,seq`; replay only if `topics.has('chat:'+agent)` and `chatBuf.get(agent).turn` equals the header turn; replays deltas with `seq > Number(seqS)` as `chat` events with ids (lite.mjs:2848-2861). Only the in-flight turn is replayable; `chatBuf` is cleared on `chatend` for that turn (lite.mjs:2823-2824). `chatBuf` is an uncapped array per agent (comment lite.mjs:2790-2800).
- Tick: `setInterval(tick, 2000)`, first tick awaited before returning (lite.mjs:2878-2880); fleet/agents recomputed per client per tick (`fleetState()`, `agentsIndex()` with 3 s cache, lite.mjs:3301).
- Heartbeat: comment line `: hb\n\n` every 25000 ms (lite.mjs:2881).
- Client cap: `SSE_MAX = 8` (lite.mjs:2746); `/stream` checks `streamClients.size >= SSE_MAX` -> `503`, `retry-after: 30`, body `too many stream clients` (lite.mjs:2828). `/events` has a separate counter `sseClients` (lite.mjs:2747-2749), so 8 + 8. Test: scripts/stream-cap-check.mjs (reads SSE_MAX from lite.mjs).
- Cleanup: `req aborted/close`, `res close` clear both intervals and drop the client (lite.mjs:2841-2844).
- Client connect: `connect(topics)` no-ops if the topic set is unchanged; otherwise `es.close()` and `new EventSource('/stream?topics=…')` (app/store.mjs:19-25). Four `addEventListener`s with `JSON.parse(e.data)` inside `try/catch {}` (app/store.mjs:26-28).
- Client reconnect: delegated to the browser; comment "EventSource reconnects on its own and resends Last-Event-ID — do not hand-roll it" (app/store.mjs:24). No `onerror`, no `visibilitychange`, no `es.close()` on view unmount (grep of app/: only store.mjs:23 calls close). Retry interval: server sends no `retry:` field (grep lite.mjs:2827-2882).
- Test-only injection `/_test/chat` gated on `MOWS_TEST_HOOKS=1` (lite.mjs:3902).

### 3.5 State held client-side (store.mjs and views)
| id | signal/state | type | set by | read by |
| S-01 | `es` | EventSource or null (module) | `connect` app/store.mjs:25 | `connect` :21,:23 |
| S-02 | `wanted` | Set of topic strings (module) | `connect` :22 | `connect` :21 |
| S-03 | `subs` | Map event -> Set of fn (module) | `subscribe` :14-15 | `emit` :18 |
| S-04 | `state = {agents:[],agent:null,chat:[],streaming:null}` | exported object | nothing writes it | nothing imports it; file comment says so (app/store.mjs:5-12) |
| S-05 | `scrollByPath` | Map path -> scrollY (module) | `navigate` app/main.mjs:11 | `route` handler :40 |
| S-06 | `path` | useState(location.pathname) in `App` | `route` event handler :40 | `route(path)` :44 |
| S-07 | `rows` | useState null/array in `AgentsList` | `/api/agents` result; `agents` event merge `{...prev, ...live}` (full snapshot decides membership) | list render app/views/agents.mjs:8,16-19,21-28 |
| S-08 | `d` | useState null/false/object in `AgentDetail` | `/api/agents/<name>` | agents.mjs:98-181 |
| S-09 | `d` | useState null/false/object in `RunView` | `/api/agents/<n>/runs/<r>` | runs.mjs:6-14 |
| S-10 | `turns` | useState array in `Chat` | chat fetch; `reconcile`; optimistic append | chat.mjs:274,292,342,423 |
| S-11 | `live` + `liveRef` | useState string + ref | `chat` events (`liveRef.current += d.delta`) | chat.mjs:275,279,299-303,459-463 |
| S-12 | `busy` | useState bool | send, `chat`, `chatend` | chat.mjs:276,303,312,482 |
| S-13 | `err` | useState string | send failure, `chatend` branches | chat.mjs:277,356,375,467 |
| S-14 | `atBottom` | useState bool | `onScroll` (<40 px from bottom), send, Jump button | chat.mjs:278,387,390,466 |
| S-15 | `turnRef` | ref number: newest turn seen | `chat` event | `chatend` guard chat.mjs:299,311,322-340 |
| S-16 | `pendingRef` | ref array of optimistic user messages `{at,role,text,baseline,reported?}` | send, `chatend` | `reconcile` chat.mjs:284,341,345,418-422 |
| S-17 | `html.agent-view`, `html.kb-open` classes, `--kb` CSS var | DOM state | agents.mjs:106-109; chat.mjs:476-477, 399 | CSS (lite.mjs:2073-2075, 2107-2108) |
Not persisted: no localStorage/sessionStorage/IndexedDB use in app/ (grep not run for these names; `not verified` beyond reading all 7 first-party files, none reference them). Every view refetches on mount (app/store.mjs:6-11).

### 3.6 Chat view behaviours (chat.mjs)
- Markdown: `marked.parse(text, {async:false, renderer, tokenizer})` (chat.mjs:138); output injected with `dangerouslySetInnerHTML` for saved turns (:458) and the live buffer (:463). No separate sanitizer library; sanitisation is three overrides plus a scheme allowlist:
  - `renderer.html` escapes raw html tokens (:101).
  - `safeHref`: trim; reject `//` or `\\` prefixes; reject `&` or `%` in the pre-`/?#` head; allow no scheme, or `http`/`https`/`mailto` (:45-57). `renderer.link`/`renderer.image` fall back to link text / alt text on refusal (:102-108).
  - `tokenizer.tag` override forces `lexer.state.inRawBlock = false` unconditionally (:83-98); comment cites vendor/marked.mjs:704, :958.
  - `renderer.code`: fences whose lang matches `^mows-memory\b` are wrapped in `<details class="memupd">` (:116-121).
  - `renderPartial`: appends `\n```` when the count of triple backticks is odd (display only) (:135-139); on throw returns `<p>`+escaped text (:140-145). Exported for scripts/chat-view-check.mjs.
- Streaming: `chat` events append to `liveRef`; a delta with a new `turn` resets the buffer (:299-303). `chatend` older than `turnRef` is ignored (:311). Client never reads `d.seq` (grep `.seq` count 0).
- Finish: `live` is held until the refetch of `/api/agents/<n>/chat` returns, then `reconcile(list, pendingRef, salvage)` and `settle()` (:322-361); on refetch failure, salvages reply into `turns` and sets an error (:363-377).
- `reconcile`: counts user turns with identical text against a per-pending `baseline`; pendings not accounted for are re-appended once and marked `reported`; salvages the streamed reply when the newest assistant turn does not include it (:168-241).
- Optimistic send: appends a pending user turn, POSTs form to `/a/agent-chat`; on non-2xx or throw withdraws the bubble, restores text to the textarea, sets `Could not send: …` (:407-441).
- Scroll anchoring: hand-written; `scrollTop = scrollHeight` when `atBottom` on change of `turns`/`live`/`atBottom` (:389-391); `atBottom` = distance <40 px (:385-388); "Jump to latest" button when not at bottom (:466). Comment: Safari lacks CSS scroll anchoring (:383). `.chatbox{max-height:60vh;overflow-y:auto;overscroll-behavior:contain}` (lite.mjs:1914).
- Composer / keyboard: `visualViewport` `resize` and `scroll` set `--kb = innerHeight - vv.height - vv.offsetTop` px on `documentElement` (chat.mjs:394-405); `focus`/`blur` on textarea toggle `html.kb-open` (:476-477); Cmd/Ctrl+Enter sends when not busy (:478); placeholder chosen once via `matchMedia('(max-width: 500px)')` (:471); composer `position:sticky;bottom:calc(var(--kb,0px)+safe-area)` (lite.mjs:1915; `.uiapp` override :2107). Viewport meta carries `interactive-widget=resizes-content` (lite.mjs:3857).
- UTF-8 split: handled server-side only, in `wireChatStream` via `stdout.setEncoding('utf8')` (chat-stream.mjs:14), unit gate scripts/chat-stream-utf8-check.mjs. Malformed lines are counted (`drops()`) and logged on child close (chat-stream.mjs:27, lite.mjs:3617-3620). Client relies on EventSource's UTF-8 decoding; no client code addresses it.
- Reconnect: no chat-specific code; relies on S-01 reconnect + server replay (3.4). `connect(['agents','chat:<name>'])` is called on mount and `name` change (:293); no disconnect on unmount (cleanup returns only `offA/offB`, :380).
- System dividers: `events` prop lines `<ISO> <text>` interleaved by timestamp, excluding `chat turn…` and `memory stored…` (:248-271).

### 3.7 Shell HTML (`uiShellHtml`, lite.mjs:3830-3868; `uiView` :3870-3876)
- Response: `send(...,'text/html; charset=utf-8',{content-security-policy})`; `cache-control: no-cache`; gzip if >1024 B (lite.mjs:2577-2590). Nonce = `randomBytes(16).toString('base64url')` per response (lite.mjs:3872-3874). `send` sets `BASE_CSP` for HTML first, then `extra` replaces it (lite.mjs:2576, 2584-2585).
- Head: `charset`, viewport `width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content` (the server-rendered `page()` viewport adds `maximum-scale=1,user-scalable=no`, lite.mjs:2447); `color-scheme dark`; `theme-color #09090b`; manifest link; `<title>mows control</title>`; one `<style nonce>` with `cssText()`; one `<script type=importmap nonce>` (lite.mjs:3856-3862).
- Body: `<body class="uiapp">`, `pageChrome('agents',null,host,'/ui/agents')` header + FAB, `<div id="app">`, `<noscript>` link to server twin, tab bar, `<script type=module nonce src=hashed main.mjs>` (lite.mjs:3863-3868; chrome built lite.mjs:3855).
- Import map: `preact`, `preact/hooks`, `htm`, `marked` -> hashed `/ui/assets/vendor/<name>.<crc32hex>.mjs` via `uiAssetUrlFor` (lite.mjs:3831-3836); plus, for every non-`vendor/` asset, `/ui/assets/<rel>` -> hashed URL so relative imports resolve (lite.mjs:3845-3849). Hash = crc32 of file bytes (`uiAssetName`, lite.mjs:3704-3708). Assets loaded at startup and lazily if empty (lite.mjs:4099 at startup, 3871, 3878).
- CSP (`uiCsp`, lite.mjs:3798-3810): `default-src 'none'`; `script-src 'self' 'nonce-…'`; `style-src 'nonce-…'`; `img-src 'self' data: https:`; `font-src 'self'`; `connect-src 'self'`; `manifest-src 'self'`; `base-uri 'none'`; `form-action 'self'`; `frame-ancestors 'none'`; `object-src 'none'`. No `unsafe-inline`/`unsafe-eval`. `BASE_CSP` for other pages: `base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'self'` (lite.mjs:2576).
- Fonts: `@font-face` Inter and JetBrains Mono, `font-weight:400 700`, `font-display:swap`, `src:url(FONT_INTER|FONT_MONO) format('woff2')` replaced with hashed URLs (lite.mjs:1378-1381, 3758-3761). No `<link rel=preload>` for fonts in the shell (lite.mjs:3856-3868).
- Speculation rules: the `<script type=speculationrules>` is in `page()` (lite.mjs:2453) not in `uiShellHtml`; its not-selector excludes `a[href^='/ui']`; its href_matches list includes `/agents` and `/agents/*` but no `/ui*`. Header comment: "never /ui*, which owns its own navigation" (lite.mjs:25-27).
- View transitions: CSS `@view-transition{navigation:auto}`, `.tabs{view-transition-name:tabs}`, 0.12 s out / 0.18 s in, reduced-motion disables (lite.mjs:1871-1877) in the shared stylesheet, so it is inlined into the shell too; same-document `startViewTransition` in app/main.mjs:13.
- Other `/ui` CSS hooks: `body.uiapp` max-width 1088 + 32 px padding >=701 px (lite.mjs:1935); `html.agent-view` hides `.termfab` and sets `.agchat` height with `100dvh` (lite.mjs:2047,2063-2075); `html.kb-open .tabs{display:none}` (lite.mjs:2074).

### 3.8 Not verified / gaps
- Versions of preact, hooks, htm (no banner in file; only `marked v14.1.3` read at marked.mjs:2).
- Whether the browser requests brotli/gzip for `/ui/assets/*`: source shows `uiAssetView` sets no `content-encoding` and does not read Accept-Encoding (lite.mjs:3877-3885); not checked on the wire (no HTTP request made). A fronting proxy (Caddy/nginx) could compress; proxy config not read.
- Real byte size of the inline `<style>` after `cssText()`; the 22 KB / ~10 KB figures are the repo's own comment (lite.mjs:3752-3756). The live file is mid-edit (CSS block added/removed), so any number would be unstable.
- EventSource platform behaviours (new EventSource object sends no Last-Event-ID; a 503 response ends the connection with no auto-retry) are browser spec facts, not exercised here. Effect on the SPA: switching topic sets (app/store.mjs:23-25) creates a new connection with no Last-Event-ID; a 503 from the cap leaves the client with no handler (no `onerror`).
- `fleetState()` cost and `agentsIndex` cost per stream client per 2 s tick not measured.
- Test scripts (scripts/chat-view-check.mjs, chat-stream-utf8-check.mjs, capability-check.mjs, stream-replay-check.mjs, stream-cap-check.mjs) listed from `ls` and preflight references; contents not read except stream-cap-check.mjs header.
- Browser-level behaviour (actual CSP violations, import-map resolution, iOS keyboard behaviour) not run; no browser session used.
- capability.mjs (view) was read for imports/keys only (first 60 lines plus a key grep), not line-by-line; its per-field rendering rules are not recorded here.
- lite.mjs line numbers: see convention at top; two file versions exist on disk over the mapping window.


## 4. Terminal
Paths: W = `infra/webconsole/`, D = `infra/dashboard/`, C = `infra/caddy/`. Measured 2026-10-11. Lines are 1-based `cat -n`.

### 4.1 Files and sizes
Sizes by the prescribed node one-liner (raw / gzip-9 / brotli, bytes).
| id | file | raw | gzip | brotli | role | cited |
|---|---|---|---|---|---|---|
| T-01 | W/blocks/10-cckb.html | 5657 | 2711 | 2307 | key bar `#cckb`, touch-scroll to wheel, keyboard-aware fit | 10-cckb:1-88 |
| T-02 | W/blocks/15-ccu11.html | 8552 | 3974 | 2718 | vendored xterm-addon-unicode11@0.6.0 + activation | 15-ccu11:1-21 |
| T-03 | W/blocks/20-ccpwa.html | 2120 | 1086 | 883 | CSS only: standalone-PWA geometry, margins for safe area | 20-ccpwa:1-33 |
| T-04 | W/blocks/30-cchome.html | 2614 | 1337 | 1039 | back key, `/z` geometry beacon, `.nozone` class | 30-cchome:1-33 |
| T-05 | W/blocks/40-ccimg.html | 2472 | 1309 | 1039 | attach image: key / paste / drop -> `POST /shot` | 40-ccimg:1-34 |
| T-06 | W/blocks/45-ccfont.html | 2123 | 998 | 803 | A-/A+ font keys, localStorage guardian | 45-ccfont:1-62 |
| T-07 | W/blocks/46-cctheme.html | 9558 | 3366 | 2678 | theme picker, 12 inline themes, global-theme poll | 46-cctheme:1-93 |
| T-08 | W/blocks/50-ccime.html | 6809 | 3041 | 2553 | mobile IME shadow-line, WS wrapper, reconnect kick | 50-ccime:1-100 |
| T-09 | W/blocks/60-ccclip.html | 4253 | 2102 | 1697 | copy overlay + paste key | 60-ccclip:1-61 |
| T-10 | W/blocks/70-ccrst.html | 2055 | 1154 | 910 | restart-pane key (tmux over pty) | 70-ccrst:1-28 |
| T-11 | W/blocks/75-ccsess.html | 7748 | 3501 | 2908 | session pill + bottom sheet, in-place switch | 75-ccsess:1-92 |
| T-12 | W/blocks/80-ccpaint.html | 11544 | 5351 | 4585 | repaint/unjam/resize-coalesce/boot diag | 80-ccpaint:1-156 |
| T-13 | W/clipboard-shim.html | 6045 | 2707 | 2253 | OSC52 sniffer + copy-on-select + telemetry; 23-line maintainer header stripped at splice | shim:1-123 |
| T-14 | W/themes.json | 6909 | 1384 | 1044 | 12 themes (canonical) | themes.json |
| T-15 | W/make-term-index.sh | 11930 | 5024 | 4291 | generates the served page | make-term-index.sh:1-219 |
| T-16 | W/web-term.sh | 17718 | 7139 | 6258 | ttyd child: picker / attach / switch (server side) | web-term.sh:1-323 |
| T-17 | W/web-term-selfcheck.sh | 3133 | 1377 | 1210 | `switch` subcommand check | selfcheck:1-78 |
| T-18 | W/webterm-settle.sh | 1407 | 825 | 725 | tmux hook payload: refresh-client + log | settle:1-22 |
| T-19 | W/tmux-buffer-to-osc52.sh | 991 | 619 | 539 | tmux buffer -> OSC52 to client ttys; not wired by repo | osc52.sh:1-18 |
| T-20 | W/claude-web-term.service.template | 4827 | 2483 | 2057 | ttyd unit (bootstrap, `-I` shim) | service.template:67 |
| T-21 | W/clipboard.conf | 2962 | 1497 | 1206 | drop-in ExecStart, `--index term-index.html` (what runs live) | clipboard.conf:40 |
| T-22 | W/mobile-journey.mjs | 22557 | 7241 | 6311 | headless phone-geometry journey | journey:1-244 |
| T-23 | C/Caddyfile.template | 10028 | 4051 | 3402 | routes | Caddyfile.template:111-155 |
| T-24 | D/lite.mjs | 288330 | 98330 | 81866 | dashboard (whole file; terminal parts in 4.4/4.5) | lite.mjs |
| T-25 | /opt/claude-dashboard/term-index.html (deployed, generated) | 771724 | 210600 | 154172 | the page `/term` serves | see below |

Deployed page composition (measured, `/opt/claude-dashboard/term-index.html`): 907 lines, 1 line of 701,377 B (line 3 = ttyd bundle; V1b-corrected); ttyd stock `<style>` from byte 2977; ttyd JS bundle `<script>` = 695,256 B; injected shim+blocks = 69,755 B; head set = 2 lines (`make-term-index.sh:166-169`). Mtime Sep 28 22:33.
Versions: `ttyd --version` = `ttyd version 1.7.4`; `/term/token` reply header `server: ttyd/1.7.4 (libwebsockets/4.3.3-unknown)` (curl, 127.0.0.1:7681). xterm.js: NO version string in the bundle. Evidence it is the 5.x line: `rendererType` appears only in ttyd's own code (not in xterm option defaults), separate `CanvasAddon`/`WebglAddon` classes, `onWriteParsed`, `allowProposedApi`, `options` object setters, `_core._writeBuffer`, `_core._renderService.clear/clearTextureAtlas`. The public `Terminal` API in the bundle has NO `input()` method (grep of API class: only resize/registerMarker/write/writeln/paste/refresh/clearTextureAtlas/loadAddon). Exact minor: not verified. Addons in bundle: Fit, Overlay, WebLinks, Canvas, WebGL, Image (sixel, off), Zmodem/trzsz (off) (bundle offsets 33747, 37230-38800). Stale comments: `10-cckb.html:34` says "xterm 4.x", `45-ccfont.html:1` says "xterm 5"; the bundle supports 5.x.
Drift found: deployed page has `ccimg-v2` (any file, no `accept`, sends `x-name` header) but repo `blocks/40-ccimg.html` is `ccimg-v1` (images only). All other 11 blocks + shim are byte-identical to the deployed page (node `includes()` check). Deployed `lite.mjs` == repo `lite.mjs` (cmp rc 0) and contains no `x-name` handler (`grep x-name` empty; `/shot` at `lite.mjs:3935-3955`). Backup `/opt/claude-dashboard/term-index.html.pre-anyfile` exists.
Not shipped in repo, live on box: `/etc/systemd/system/claude-web-term.service.d/clipboard.conf` + `tmux.conf` drop-ins; live ExecStart = `ttyd --port 7681 --interface 127.0.0.1 --base-path /term --writable --url-arg -t fontSize=14 -t rendererType=canvas --index /opt/claude-dashboard/term-index.html /opt/claude-dashboard/web-term.sh` (systemctl cat).

### 4.2 Blocks (splice order = filename order; shim first) -- one row per block
Common facts: all blocks are classic inline scripts, global scope, no module. They share NO code: `ta()`, `pst()` (synthetic ClipboardEvent paste into `.xterm-helper-textarea`) and the `send()` fallback are copy-pasted into several blocks. "ttyd globals" = `window.term` (set by ttyd at `term-index.html` bundle offset 33687: `window.term=t, window.term.fit=...`), `#terminal-container`. Synthetic `window` `resize` events are how blocks make ttyd re-fit (ttyd listens: `u(window,"resize",()=>t.fit())`, bundle offset ~34400).
| id | block | what it does | DOM/API it hooks | mobile-only? | kill switch | file:line |
|---|---|---|---|---|---|---|
| B-00 | clipboard shim v2 | (1) replaces `window.WebSocket` with a wrapper; every ws message ArrayBuffer/Blob whose byte0 == 0x30 ('0' OUTPUT) is Latin-1 decoded and scanned with `/\x1b\]52;[^;\x07\x1b]*;([A-Za-z0-9+/=]*)(?:\x07\|\x1b\\)/`; payload base64->UTF-8 -> `navigator.clipboard.writeText`; blocked -> held in `pending`, flushed on next keydown/mousedown; 32 KB carry cap. (2) mouseup after drag >=6px -> `document.execCommand('copy')`. (3) pings `GET /term/__shim?<event>` (404 by design, lands in Caddy log) | `window.WebSocket` (global monkeypatch), `navigator.clipboard`, `document.execCommand`; NO xterm internals | no (desktop copy-on-select is the point) | none | shim:25-122 (WS 100-113, OSC 77-98, copy-on-select 116-121, ping 32-35) |
| B-10 | cckb | builds `#cckb` fixed bottom bar, buttons Esc NL IND Tab S-Tab UP DN LT RT PgUp PgDn ^C ^Bd KB. Keys fire synthetic `KeyboardEvent('keydown')` on `.xterm-helper-textarea` (key/keyCode/ctrl/shift); NL/IND via synthetic paste; PgUp/PgDn = 6 synthetic `WheelEvent`s (deltaY 57) on `.xterm-screen`; ^Bd = raw `\x11` then `d` 100 ms later via `term.input` else `term._core.coreService.triggerDataEvent(d,true)` (tmux prefix is C-q, `os/tmux.conf:2`). Touch scroll on `.xterm-screen` -> wheel notches (14 px/notch, max 3/frame, inertia tau 300 ms, v cap 2.5 px/ms), `touchmove` `preventDefault`. `visualViewport` resize/scroll (debounce 120 ms + settle 520 ms) pins bar and sets `#terminal-container` height, dispatches `resize` | `.xterm-helper-textarea`, `.xterm-screen`/`.xterm`, `#terminal-container`, `window.term`, `term._core.coreService` (private, fallback only), `visualViewport`, `matchMedia(pointer:coarse)` | bar CSS `display:flex` only under `@media(pointer:coarse)` (10-cckb:8); JS builds bar + touch listeners on all devices; `vfit` returns early if not coarse | none | 10-cckb:10-88 (keys 21-37, ^Bd 34, touch 42-64, vfit 69-87) |
| B-15 | ccu11 | embeds Unicode11 addon UMD; polls 50 ms x200 for `window.term` + `window.Unicode11Addon`, then `T.loadAddon(new Unicode11Addon()); T.unicode.activeVersion='11'` (emoji width 2 to match tmux 3.4). Needs `allowProposedApi:true` (ttyd sets it, bundle offset 24295) | `window.term`, `term.loadAddon`, `term.unicode.activeVersion` (proposed API) | no | `?u11=off` | 15-ccu11:12-21 |
| B-20 | ccpwa | CSS: `html,body{background:#161b22}`, `body{overscroll-behavior:none}`; coarse: `#cckb` min-height 46 + L/R safe-area padding, `#terminal-container` height `calc(100% - 48px - env(safe-area-inset-bottom))` + L/R margins; `body.nozone` variants. Insets are margins because ttyd FitAddon measures parent `clientHeight` (comment 6-10) | `#terminal-container`, `#cckb`, body class `nozone` | coarse-pointer media block (20-ccpwa:20-32); bg rules all | none | 20-ccpwa:1-33 |
| B-30 | cchome | prepends back key `‹` (`pointerdown` -> `location.href='/'`); 900 ms later measures env() insets and lvh/dvh/svh and sends `fetch('/z?t=term-v8&...')`; if `screen.height-innerHeight>40` and display-mode standalone adds `body.nozone` + dispatches `resize` | `#cckb`, `matchMedia(display-mode: standalone)`, `/z` | key shown only where bar is (coarse); beacon on all | none | 30-cchome:1-33 |
| B-40 | ccimg (repo v1; deployed v2) | 📸 key (inserted at child index 1) -> hidden `<input type=file accept=image/*>`; capture-phase `paste` (image items), `dragover`/`drop` -> `up(file)`: `POST /shot` body=file, header `content-type`; reply `{ok,path}` -> `pst(path+' ')`. Deployed v2: any file type, `x-name` header | `#cckb`, `.xterm-helper-textarea`, document paste/drop, `/shot` | key: coarse only (bar); paste/drop: all | none | 40-ccimg:6-33 |
| B-45 | ccfont | appends `A-`, size span, `A+`; sets `T.options.fontSize` 8..22 + dispatches `resize`; persists `localStorage.ccfontsize`; a 1 s guardian re-applies the stored size when ttyd's pref push (`-t fontSize=14`, applied on every ws preamble/reconnect) stomps it (>2 s since last tap) | `window.term.options.fontSize`, `#cckb`, localStorage | keys: bar (coarse); guardian runs on all | none | 45-ccfont:1-62 (guardian 35-40) |
| B-46 | cctheme | 12 themes inlined (identical JSON to `themes.json`, verified by eval compare). `<select id=ccthemesel>` appended to bar ("Auto (global)" + 12). Effective theme = localStorage `cctheme` if known, else global theme from `GET /settings/term-theme.json` (fetched at init and every 30 s), else ttyd default captured at init. Applies `T.options.theme = obj` (selectionBackground +"80" alpha when 7 chars), sets `document.body.style.background` and `<meta name=theme-color>`. 1 s guardian re-applies if background/foreground drift. `?theme=<Name>` saves; unknown (e.g. `default`) clears. Exposes `window.cctheme(name)` | `window.term.options.theme`, `meta[name=theme-color]`, body background, localStorage, `/settings/term-theme.json` | picker on bar (coarse); URL/console path for desktop; apply+guardian on all | `?theme=off` | 46-cctheme:15-92 (THEMES 18, effective 28-33, apply 37-45, global fetch 47-61, guardian 69-80) |
| B-50 | ccime | Touch only. Wraps `window.WebSocket` again; keeps the `/ws` socket as `CCWS`, exports `window.__ccimeWS()` and `window.__ccimeKick()`. "Shadow-line": hidden xterm textarea keeps the typed line; trusted keydown/keyup/keypress/input/composition events are stopped at document-capture; value diff replayed as `\x7f`xN + new tail via `term.input` else `_core.coreService.triggerDataEvent`. Enter = synthetic keydown (so ttyd's `onKey` "Press Enter to Reconnect" works). Sets textarea `autocomplete/autocorrect/spellcheck/enterkeyhint=send`. Swallows `historyUndo/Redo`. Multiline paste -> `pst()` (bracketed paste). Reconnect kick on visibilitychange/pageshow/online (+300/+1500 ms) when `CCWS.readyState>1` | `.xterm-helper-textarea`, `window.term`, `term._core.coreService.triggerDataEvent` (private fallback), ttyd's `terminal.onKey` reconnect path, WS ctor | YES: `if(!matchMedia('(pointer:coarse)').matches)return` | `?ime=off` | 50-ccime:19-99 (WS wrap 21-26, kick 33-38, engage 52-94, poll 95-98) |
| B-60 | ccclip | Two bar keys inserted at index 2: `⧉` snapshots `term.buffer.active` (`getLine(i).translateToString(true)`, rows with `isWrapped` re-joined) into `<pre id=ccclip-txt>` full-screen overlay `#ccclip` with "copy all"/"close"; `📋` reads `navigator.clipboard.readText()` on `pointerup` and `pst()`s it | `window.term.buffer.active` (public), `.xterm-helper-textarea`, `navigator.clipboard` | keys on bar (coarse) | `?clip=off` | 60-ccclip:27-60 (grab 34-38) |
| B-70 | ccrst | `⟳` key at index 4; `confirm()`, then staged input: `\x11`, 120 ms `:`, 260 ms `respawn-pane -k`, 420 ms `\r` (staged because tmux assume-paste-time treats bursts as paste) | `window.term.input` else `_core.coreService.triggerDataEvent` | key on bar (coarse) | `?rst=off` | 70-ccrst:15-27 |
| B-75 | ccsess | Returns early unless coarse. Reads `?arg=` list: `args[2]`=tabid (8 hex), `args[0]=='attach'` -> `args[1]`=session. Pill `#ccsess-pill` (index 1) + bottom sheet `#ccsheet`. `poll()` = `GET /app/live.json?tab=<tabid|00000000>` every 10 s + on open + on visibilitychange. Row click -> `POST /a/switch` (urlencoded `tab`,`to`); ok -> update pill in place; failure/no tabid -> `location.href='/term/?arg=attach&arg=<to>&arg=<tab|minted>&v=3'`. "new session" -> `/term/?v=3`; "all sessions" -> `/`. CSS: coarse `#terminal-container{width:calc(100% + 15px)}` (iOS has no scrollbar; FitAddon reserves 15 px) | `#cckb`, `#terminal-container`, `location.search`, `/app/live.json`, `/a/switch`, `crypto.getRandomValues` | YES (JS early return 51; CSS coarse 20) | none | 75-ccsess:49-91 |
| B-80 | ccpaint | (a) `repaint()`: `term._core._renderService.clear()` + `term.clearTextureAtlas()` + `term.refresh(0,rows-1)`, never resizes pty. Triggers: visibilitychange/pageshow/focus, `webglcontextrestored`, 1 s timer late >2.5 s ("frozen"), new ws seen via `__ccimeWS`, first-content (empty->non-empty buffer). (b) replaces `term.resize` with 150 ms-coalesced version that waits until `term._core._writeBuffer._pendingData==0`. (c) 1 Hz unjam watchdog: `_pendingData>0` non-decreasing for 2 ticks -> `_writeBuffer._innerWrite()`. (d) boot ladder at 4/8/15 s if buffer empty: repaint, `__ccimeKick`, `location.reload()` (max 2, `sessionStorage ccpaint-r`). (e) beacons `/z?t=termdiag&e=...` (ws-new/open/close/err/first-msg/5 s, buf3000/buf9000, jserr, reject) via a THIRD `window.WebSocket` wrapper | `window.term`, `term._core._renderService`, `term._core._writeBuffer` (`_pendingData`, `_innerWrite`), `term.resize` override, `term.buffer.active`, `window.__ccimeWS/__ccimeKick`, `window.WebSocket` | no (all devices) | `?paint=off`; `?paintdbg=1` logs | 80-ccpaint:30-155 (resize 54-62, diag 77-99, ladder 103-111, watchdog 137-145) |
Key-bar final child order on a phone (derived from the insert indexes): `‹`, pill, `📸`, `⧉`, `📋`, `⟳`, Esc ... KB, then `A-` span `A+`, then theme select (45/46 append async). cchome 30-cchome:6, ccsess 75-ccsess:64, ccimg 40-ccimg:26, ccclip 60-ccclip:54-60, ccrst 70-ccrst:27. Blocks 40/60/70/75 depend on index positions (75-ccsess header 15-16).
`window.WebSocket` is wrapped three times (shim, ccime, ccpaint-diag); order of wrap = splice order.
Beacons/sinks used by the page: `/term/__shim?*` (404), `/z?*` (204), `POST /shot` (200 JSON).

### 4.3 ttyd protocol (from the deployed bundle; ttyd 1.7.4)
- Page URL `/term/` + `?arg=<mode>&arg=<name>&arg=<tabid>&v=3`. ttyd runs with `--url-arg`, so each `arg` becomes argv of `web-term.sh` (service.template:67; `web-term.sh:242-309`). Modes: `attach` (name), `menu`, `open` (sid8), `resume`, `resolve`, `list`, `run`, `switch`.
- ws path: `wss://<host><pathname minus trailing /> + "/ws" + location.search` (bundle offset 23380). Subprotocol `["tty"]`; `binaryType="arraybuffer"` (offset 35363). Same page URL therefore sends the `?arg=` query on the ws URL. Caddy `handle /term*` -> ttyd:7681 (4.6).
- Token: `GET <pathname>/token` -> `{"token": ""}` (live curl: 200, `content-length: 13`). Fetched before connect and before every reconnect (`refreshToken`, offsets 33233, 36020).
- Auth: none inside ttyd (`AuthToken` empty; no `-c`/`-A` in the unit). Gate is Caddy `forward_auth` to oauth2-proxy `127.0.0.1:4180` (`Caddyfile.template:35-55`), ttyd bound to 127.0.0.1 (`service.template:67`).
- Client -> server: first frame after open = UTF-8 JSON, NO prefix byte: `{"AuthToken":<token>,"columns":N,"rows":N}` (`onSocketOpen`, offset 35616). Then binary frames with a 1-char ASCII prefix: `'0'`+bytes = input (`sendData`, string UTF-8 encoded, bytes via onBinary also '0'); `'1'`+JSON `{"columns":c,"rows":r}` = resize (on `terminal.onResize`); `'2'` = pause, `'3'` = resume (flow control, limit 1e5 / high 10 / low 4, offset 24290).
- Server -> client: first byte ASCII `'0'` output (bytes -> `terminal.write`), `'1'` title string (sets `document.title`), `'2'` JSON preferences merged over client options: `rendererType`, `fontSize`, `disableLeaveAlert`, `disableResizeOverlay`, `disableReconnect`, `enableZmodem/Trzsz/Sixel`, `titleFixed`, `isWindows`; any other key is assigned to `terminal.options[key]` and `font*` keys trigger `fit()` (offset 36759-37700). Unknown prefix -> `console.warn`.
- On open after a previous open: `terminal.reset()` + "Reconnected" overlay. On close: code 1000 -> overlay `Press ⏎ to Reconnect` (bundle offset 36401) via `terminal.onKey` Enter; else auto "Reconnecting..." after `refreshToken` (offset 36020). A socket `error` sets `doReconnect=false` (offset 35470), so backgrounded phones land in the press-Enter branch (stated 50-ccime:7-12).
- Other ttyd client behaviour the page relies on: `onTitleChange` -> `document.title = title + " | " + this.title` unless `titleFixed`; `onSelectionChange` -> `execCommand('copy')` (so selection already copies; shim 116-121 is a second copy path); resize overlay `"<cols>x<rows>"`; `beforeunload` "Close terminal?" prompt (offset 33400); `window.resize` -> `fitAddon.fit()`.
- Server-side ttyd options (live): `-t fontSize=14 -t rendererType=canvas` (WebGL off because ttyd 1.7.4 cannot recover a lost context, `service.template:43-53`); NO `-t titleFixed` on purpose (`service.template:36-41`); `--writable`; `--base-path /term`.
- ttyd's stock client defaults (bundle offset 23723-24300): `rendererType:'webgl'`, `fontSize:13`, `fontFamily:"Consolas,Liberation Mono,Menlo,Courier,monospace"`, 16-colour theme, `allowProposedApi:true`; container `#terminal-container` (height 100%), `#terminal-container .terminal{height:calc(100% - 10px);padding:5px}`.

### 4.4 Themes
- `W/themes.json`: 12 objects keyed by name: Material, Material Dark, Material Darker, Material Ocean, Material Design Colors, Oceanic Material, Nord, Catppuccin Mocha, TokyoNight, Rose Pine, GitHub Dark, GitHub Light. All 12 have the identical 20-key schema: black red green yellow blue magenta cyan white + bright* variants (16 ANSI), background, foreground, cursor, selectionBackground; hex `#rrggbb`. (verified by node; keys renamed purple->magenta, cursorColor->cursor per 46-cctheme:6-8.)
- Duplicated, not shared: the same JSON is pasted inline in `46-cctheme.html:18` (verified equal by eval compare, 12/12) and read by the dashboard at start (`lite.mjs:134-148` `loadThemeMap()`, looks for `D/themes.json` then `../webconsole/themes.json`; the deployed `/opt/claude-dashboard/themes.json` is 6909 B, same size). Header says "keep in sync" (46-cctheme:11).
- Endpoints (`lite.mjs`): `GET /themes.json` -> whole map (3986); `GET /settings/term-theme.json` -> `{name, theme}` where `name` = `settings.json.termTheme` ('' if unset) and `theme` = map entry or null (3987-3992); `POST /settings/term-theme` JSON `{name}`, same-origin check, max 4096 B, name must be '' or a map key, then `saveSettings({termTheme:name})` (3993-3996, handler 762-784). Storage: `SETTINGS_FILE` default `/opt/claude-dashboard/settings.json` (`lite.mjs:132`, read/write 150-164); live content `{"termTheme": "GitHub Dark"}`.
- Browser side: per-browser override in `localStorage.cctheme` (name); global fallback polled every 30 s; picker only in the touch key bar; desktop sets via `?theme=` or `cctheme()` console fn (46-cctheme:6-14, 62, 68). The block only reads `d.name` from the global endpoint and ignores `d.theme` (46-cctheme:54-56) and `/themes.json` (not fetched by any block).
- No dashboard UI writes the global theme: `lite.mjs:1241-1245` states "no dashboard UI"; grep of `lite.mjs` and `D/app/` finds no caller of `POST /settings/term-theme` (only the handler). The dashboard's own colours are separate CSS tokens: `:root{color-scheme:dark;--bg:#09090b;--card2:#18181b;--ok:#00d492...}` (`lite.mjs:1359-1368`); terminal chrome colours are hardcoded `#161b22 #21262d #30363d #e6edf3 #3fb950 #238636` in the blocks and are NOT themed (only terminal body bg + `meta theme-color` follow the theme, 46-cctheme:39-42). Dashboard `theme-color` is `#09090b` (`lite.mjs:2448`); terminal page head sets `#161b22` (`make-term-index.sh:168`).

### 4.5 Persistent shell (/app, /a/switch, /app/live.json), `.termfab`, manifest, /shot
- `termHref(kind,name)` = `/term/?arg=<kind>&arg=<name>&arg=<8-hex tabid>&v=3` (`lite.mjs:2600-2602`; `attachHref` client-side copy 2909). Every dashboard `>_` link, header "New Session" and the FAB use it (`2440`, `3041`, `3091`, `3102`, `3266`); `data-nw` reuses one browser window per session on desktop (2465-2471).
- `GET /app[?s=<name>][&open=<sid8>]` (`appView` 2613-2620): 302 to `termHref('open',sid8)` if `open` is 8 hex; else initial session = `?s=` if live, else `~/.cache/webterm-last` if live, else first live (`initialSession` 2605-2612) -> `termHref('attach',S)`; none live -> `/term/?v=3` (picker). `cache-control: no-store`. It is the PWA `start_url` (`manifest()` 2704-2716, `start_url:'/app'`, `scope:'/'`, `display:'standalone'`).
- `POST /a/switch` (`switchAction` 547-559): same-origin; form fields `tab` (8 hex), `to` (live tmux name or 8 hex); runs `web-term.sh switch <tab> <to>` as TMUX_USER via `runuser` (20 s). Exit 0 -> `200 {ok,current}`, 2 -> `409 tab not attached`, 3 -> `404`, else 500; bad tab/to -> 400. `web-term.sh switch` (284-308): looks up `~/.cache/webterm-clients/<tab>` (tty), resolves/creates session (`ensure_session`), no-ops if client already there, else `tmux detach-client -s =<n>`, `tmux switch-client -c <tty> -t =<n>`, rewrites `<tab>.sess`.
- `GET /app/live.json?tab=<8hex>` (`liveJson` 2622-2640): 400 if bad tab; else `[{name,label,current}]` from `tmuxLive()` (3 s cache, 255-261); `current` = session of the tmux client whose tty is in `webterm-clients/<tab>`. `no-store`.
- Per-tab registry (`web-term.sh:79-90`): `register_tab` writes `$(tty)` to `~/.cache/webterm-clients/<tabid>` (prune >1440 min); `mark()` writes `<tabid>.sess` + OSC 2 title + `~/.cache/webterm-last` (72-75). A ttyd reconnect re-runs the script with the ORIGINAL url args; `.sess` overrides them (246-253, 271-283).
- `.termfab`: `<a class="termfab" href=termHref('menu','')>` placed by `pageChrome()` on every dashboard page (`lite.mjs:2440`); CSS 1441, 1582-1585 (fixed, bottom-right, 46 px circle, `--ok`), hidden when `body.watchlive` / `devfs` / `html.agent-view` (1585, 1843, 2073).
- `POST /shot` (`3935-3955`): body <= 15 MB else 413; saves to `/opt/claude-dashboard/shots/shot-<ms>.<ext>` (ext from content-type: png/webp/gif else jpg), prunes files >7 d, replies `{ok:true,path}`; GET -> 302 `/`. `GET /z` -> 204 (3934). Caddy: both fall to the default `handle` -> 127.0.0.1:3005 behind `gauth`.
- Manifest/icons: Caddy `(pwa)` route sends `/manifest.webmanifest /sw.js /icon-192.png /icon-512.png /apple-touch-icon.png /favicon.png /favicon.ico` to :3005 WITHOUT auth (`Caddyfile.template:87-92`); terminal head links manifest with `crossorigin="use-credentials"` (`make-term-index.sh:168`). `sw.js` is network-only with an offline stub (`lite.mjs:2720-2727`).
- tmux side: `os/tmux.conf:2` prefix C-q, `:13` mouse on, `:23-24` set-titles (`#{?@label,#{@label},#S} · #{b:pane_current_path}`), `:42-43` client-attached/client-resized hooks run `/opt/claude-dashboard/webterm-settle.sh` after 2 s.

### 4.6 Caddy routing (`C/Caddyfile.template`; live `/etc/caddy/Caddyfile:77-89` is the same shape)
- Site block `{{DOMAIN}}` 112-155: `encode @nosse zstd gzip` (123; live has `encode zstd gzip`), then `route { import pwa; webhook; gauth; vncproxy; droidproxy; sse; ... }` (124-130).
- `@termhtml path /term /term/` (137): `root * /opt/claude-dashboard`, `rewrite * /term-index.html`, `header Cache-Control "no-cache"`, `file_server` (138-143) -> real ETag, 304 revalidation. Runs AFTER `gauth` (auth-gated).
- `handle /term*` (144-150): prefix wildcard -> `reverse_proxy 127.0.0.1:7681`. This covers `/term/ws`, `/term/token`, `/term/__shim` (404 at ttyd) and ANY other path starting `/term` (comment 145-148: dashboard routes must never start with `/term`).
- Everything else `handle {}` (151-153) -> `127.0.0.1:3005` (dashboard: `/app`, `/a/switch`, `/shot`, `/z`, `/themes.json`, `/settings/term-theme*`, `/app/live.json`).
- Per-profile subdomain blocks (161-174) proxy only to :3005, no `/term` handling.
- `gauth` (35-55): HSTS, nosniff, `Content-Security-Policy: frame-ancestors 'self'`, `Referrer-Policy: same-origin`; `forward_auth 127.0.0.1:4180`, 401 -> redirect to `/oauth2/start`. No script-src CSP on the term page (generated page has inline scripts; `lite.mjs BASE_CSP` applies only to dashboard HTML, 2569-2584).

### 4.7 Existing checks (what each asserts)
- `web-term-selfcheck.sh` (backend only, no browser): creates `wt-selfcheck-a/b` tmux sessions + a real pty client via `script`; asserts (1) client attaches to A within 5 s (47-53), (2) `web-term.sh switch deadbeef B` exits 0 and prints `B` (58-63), (3) `list-clients` shows the tty on B (65-70), (4) unknown tabid -> exit 2 (72-73), (5) unresolvable target -> exit 3 (75-76). Cleans up by trap. Prints `ALL CLEAN`.
- `mobile-journey.mjs` (headless Chromium, `isMobile`, `hasTouch`, DPR 3, 4 phones: Pro Max 440x956, iPhone 15, SE, landscape 956x440; page stubbed in with `/term/ws` + `/term/token` -> 404, 63; needs a running dashboard at `$DASH` default `127.0.0.1:3099`, playwright-core from npx cache, a Playwright chromium, `web-term.sh`). A. dashboard per phone (81-100): header on-screen, tab bar flush/hidden, no horizontal overflow, attach links match `^/term/\?arg=(attach|open)&arg=[^&]+&arg=[0-9a-f]{8}&v=3$`, no page errors. B. terminal per phone (103-148): first key `‹` and pill visible; key bar < 50 px and `kbBottom === innerHeight`; terminal ends above bar; `innerWidth - .xterm-screen.right <= xterm paddingRight + cell width` (reads `window.term._core._renderService.dimensions.css.cell.width`, line 110); sheet anchored bottom, <=70% tall, rows >=52 px, current row marked; click row -> `POST /a/switch` 200, URL unchanged, tmux client now on B; no `#ccdrawer`; "all sessions" navigates to `/`; attach on current session navigates; ‹ navigates to `/`. C. edges (151-241): no-tabid menu page -> pill reads `sessions`, click row reloads into `attach` with minted tabid; unregistered tab -> 409 -> one reload same tabid; empty live list -> "none running" + new/all rows; vanished current session; 520 px-tall viewport (`kbBottom===ih`, `#terminal-container`>300 px, `term.rows>=10`); desktop 1280x800: no pill, no sheet, `‹` navigates; motion-on: `#ccsheet .pan` transition-property has `transform`, sheet settles flush in 1.5 s, backdrop tap -> `display:none`; no `embed=1|data-close|data-sw|--sat:|postMessage` in `/ /settings /watch /droid`; no iframe in terminal page; `/app?s=A` -> 302 to `/term/?arg=attach&arg=A&arg=<8hex>&v=3`, `/app` -> 302 `/term/?arg=`. Prints `N/M passed`. Headless CANNOT see iOS keyboard / real safe-area / inertia (header 12-13).
  Not asserted anywhere: ws/token framing, OSC52, IME, copy/paste overlay, restart key, font keys, theme picker, image upload, repaint/unjam, unicode width. Journey bug: `TERM` env var is read as the page path when `TERM_PAGE` is unset (line 21; shell `TERM` is normally `xterm-256color`).
- `webterm-settle.sh` is not a check: tmux hook payload (2 s after client-attached/resized) runs `tmux refresh-client -t <client>`, sleeps 0.3 s, appends the last 4 lines of `capture-pane` to `~/.cache/webterm-hook.log` (self-truncates >200 KB) (settle:15-22). It is the server-side evidence trail for the render/race bug described in 80-ccpaint:43-53.
- `make-term-index.sh` self-checks before write (177-204): marker `mows clipboard shim v2` present and after `<head>`; exactly one `name="viewport"` meta and `apple-mobile-web-app-capable`; every block's first `id="cc..."` present. Regeneration starts a throwaway ttyd on a port in 7699-7799 and fetches `/` (75-125), splices head meta after `<head>` (170-175) and `shim+blocks` before the first `</body>` (157-162).

### 4.8 Not verified / gaps
- Exact xterm.js minor version (no string in bundle); exact versions of the Fit/Canvas/WebGL/WebLinks addons.
- `mobile-journey.mjs` and `web-term-selfcheck.sh` were NOT run (they create tmux sessions); their pass state today is unknown.
- No browser run of the deployed page; behaviours in 4.2 are from source reading, plus byte comparison of repo vs deployed. Real-device iOS behaviours (keyboard, safe area, screen-lock freeze) are as documented in block comments only.
- `/term/__shim`'s 404 at ttyd and `GET /term` 302 from ttyd direct (`curl 127.0.0.1:7681/term` returned 302) observed only partially (token endpoint observed 200).
- `lite.mjs` size changed during this mapping (first measure 281081 B, later 288330 B; repo mtime Oct 11 02:13, deployed Oct 10 01:43, `cmp` equal at the end): line numbers above were re-checked against the 288330 B file.
- Whether anything outside the repo POSTs `/settings/term-theme` (only the live `settings.json` value shows it was set once, Aug 25).
- `ccimg-v2` server counterpart (`x-name`) not found in `lite.mjs`; behaviour for non-image uploads therefore stores as `.jpg` (ext mapping at 3947-3948), unconfirmed by test.
- Per-tab sessionStorage / localStorage keys used: `ccfontsize`, `cctheme` (localStorage); `ccpaint-r` (sessionStorage). No others found by grep of blocks.


## 5. Device stage
Paths relative to <repo>/infra. `lite.mjs` = dashboard/lite.mjs, read at 288330 B / 4101 lines (it grew from 281081 B during mapping; another agent is editing it, so line numbers after ~L1000 drift; snapshot at scratchpad/map/lite.snapshot05.mjs).

### 5.1 Files
| id | file | size | role | cited |
|----|------|------|------|-------|
| V-01 | dashboard/lite.mjs | 288330 B | server-rendered /device page, droid+watch actions, inlined CSS/JS | lite.mjs:562-899 (device code), :3972-3984 (routes) |
| V-02 | droid/SETUP.md | 6306 B | redroid + patched ws-scrcpy install guide | droid/SETUP.md:1-end |
| V-03 | droid/up.sh | 902 B | CLI: `docker start redroid`, loop `adb connect` until sys.boot_completed=1 | droid/up.sh:8-12 |
| V-04 | droid/ws-scrcpy.patch | 8629 B | patch to NetrisTV/ws-scrcpy: 6 files (TouchControlMessage.ts, StreamClientScrcpy.ts, InteractionHandler.ts, BasePlayer.ts, HttpServer.ts, app.css) | ws-scrcpy.patch:1,15,52,83,102,116 (diff headers); purposes per droid/SETUP.md:70-84 |
| V-05 | droid/ws-scrcpy.service.template | 1493 B | systemd unit, node dist/index.js, :8000, boot-enabled; ExecStartPre adb start-server + adb connect 127.0.0.1:6555 | ws-scrcpy.service.template:20-27 |
| V-06 | qa-watch/watch-browser.sh | 3048 B | starts Xvfb :99 (1920x1080x24), fluxbox, x11vnc :5901 -localhost -nopw, websockify 127.0.0.1:6080 --web=/usr/share/novnc/, Chrome with CDP 9222, xdotool raise loop | watch-browser.sh:19-26,40-44,47-52 |
| V-07 | qa-watch/claude-qa-watch.service.template | 1954 B | Type=oneshot, RemainAfterExit=yes, ExecStart bash ~/watch-browser.sh; not boot-enabled | claude-qa-watch.service.template:24-34 |
| V-08 | qa-watch/SETUP.md | 7479 B | apt deps (xvfb fluxbox x11vnc websockify novnc xdotool), Chrome/Chromium notes, MCP snippet | qa-watch/SETUP.md:11-40 (rest not read) |
| V-09 | caddy/Caddyfile.template | 9.8K | `(vncproxy)`, `(droidproxy)`, `(gauth)` snippets + `droid.` vhost | Caddyfile.template:35-74, 112-132, 161-190 |
| V-10 | os/sudoers.d/claude-harness.template | not measured | sudo grant for exact `systemctl start|stop claude-qa-watch` | claude-harness.template:62-63 (only 2 lines read) |

No device/droid/vnc reference exists in dashboard/app/*.mjs or app/views (grep, no hits): /device is only in the server-rendered lite.mjs, not in the /ui app.

### 5.2 /device page anatomy
- Handler `deviceView` lite.mjs:861-900. Route `if (p === '/device') return await deviceView(...)` lite.mjs:4003. Rendered via `page('device · mows sessions', body, head, bodyClass, 'device', ...)` lite.mjs:900; nav tab "Device" at lite.mjs:2424, 2434; `/device` is in the speculationrules prerender list lite.mjs:2453.
- Layout: `.devlayout` flex = 320px `.devrail` (left) + `.devstage` dashed box (right) lite.mjs:897-899, CSS 1788-1789, 1834. Below 700px the rail stacks above the stage, lite.mjs:1858-1867.
- Segments are labelled **Mobile** and **Web** (not "QA-watch"): `.segtoggle` of two links `/device?dv=mobile` and `/device?dv=web`, lite.mjs:869-870. Selected by `?dv=`; if absent, Mobile when droid state != stopped, else Web when watch is up, else Mobile, lite.mjs:864-867. Segments are full page navigations (anchors), not client-side tabs.
- Rail contents per segment, lite.mjs:872-886:
  - Mobile: `androidInfoCard` (name "Android Emulator", sub `redroid · 127.0.0.1:6555`, LIVE badge only when live; rows STATE RUNNING|BOOTING|STOPPED, RESOLUTION when known, TARGET) lite.mjs:710-721; `androidControlCard` (POST form Start/Stop Emulator, link Refresh, link Console -> `/droidview/` target=_blank, help paragraph with adb install / maestro commands and `termHref('menu','')` link) lite.mjs:722-736.
  - Web: `browserInfoCard` (name "QA Browser", sub "Xvfb :99 · Chrome (noVNC)", STATE LIVE|IDLE, PORT 6080) lite.mjs:786-794; `browserControlCard` (POST form Start/Stop Browser, Refresh link, help text re `watched` QA mode) lite.mjs:795-808; `remoteKeysCard` rendered only when watch is up: 8 icon buttons (keyboard, paste, PageUp, PageDown, back, forward, F5, Escape) with inline `onclick` -> kb()/pst()/k()/nav() lite.mjs:813-826.
- Stage embedding:
  - Mobile live, desktop UA: `<iframe class="vnc" src="/droidview/#!action=stream&udid=127.0.0.1:6555&player=tinyh264&fitToScreen=true&ws=wss://<host>/droidview/?action=proxy-adb&remote=tcp:8886&udid=...">` lite.mjs:743-753. Decoder = ws-scrcpy `tinyh264` (wasm) lite.mjs:740-742. No canvas inline in the dashboard; the canvas lives inside ws-scrcpy's page.
  - Mobile live, phone UA (regex `iPhone|iPad|iPod|Android|Mobile|Silk`): no iframe; renders a CTA link "Open Screen (full page)" to the same stream URL, reason: iOS ignores iframe meta viewport, lite.mjs:744-751 (SETUP corroborates droid/SETUP.md:100-104).
  - Mobile booting / stopped: empty-state placeholder (`stageEmpty`) lite.mjs:754-758 (helper `stageEmpty` immediately above the TOUCHTEST comment at lite.mjs:644, ~L640-643).
  - Web up: `<iframe id="vf" class="vnc" src="/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&quality=9&compression=6&path=vnc/websockify" allow="clipboard-read;clipboard-write">` lite.mjs:847-850. Decoder = noVNC (RFB) served by websockify's `--web=/usr/share/novnc/` (watch-browser.sh:26). Web idle: placeholder lite.mjs:851.
- Start/stop controls: `<form method=post>` buttons (full page POST then 303 back), no fetch/XHR. Mobile -> `/droid/start|stop` -> redirect `/device?dv=mobile` lite.mjs:705; Web -> `/watch/start|stop` -> redirect `/device?dv=web` lite.mjs:592.
- Status: server-side probes at request time, no SSE and no client polling for state.
  - `droidState()` lite.mjs:684-692: `docker inspect -f {{.State.Running}} redroid` -> `adb -s 127.0.0.1:6555 shell getprop sys.boot_completed` -> `adb shell wm size`; each call via `sh()` with 5s timeout lite.mjs:250. Not cached.
  - `watchLive()` lite.mjs:576-580: TCP connect probe to 127.0.0.1:6080 (800ms timeout, lite.mjs:569-575), cached 3s.
  - Only auto-refresh: `<meta http-equiv="refresh" content="4">` injected into head when droid state == 'booting', lite.mjs:896. "this page refreshes itself" caption at lite.mjs:756.
- Full-screen toggle: on live stage only, `.fsbtn` with inline `onclick="document.body.classList.toggle('devfs')"` lite.mjs:889-893; CSS fixed overlay `body.devfs .devstage.live` lite.mjs:1836-1843 (comment: iOS lacks iframe Fullscreen API).
- bodyClass `watchlive` when droid live or watch up (widens to 1720px, hides `.termfab`) lite.mjs:895, 1389, 1585.
- Stage sizing: `.vnc` 16:9 default; desktop live stage height `calc(100dvh - 210px)`, min 600px lite.mjs:1649, 1846-1849.
- Terminal theme/restart controls are NOT on this page: deviceView body only has rail + stage (lite.mjs:897-899), though the comment at lite.mjs:854-857 says one tab consolidates settings.

### 5.3 Endpoints
| id | endpoint | method | handler file:line | what it does |
|----|----------|--------|-------------------|--------------|
| E-01 | /device | GET (not method-checked) | lite.mjs:4003 -> deviceView 861 | renders page |
| E-02 | /droid/start | POST (405 otherwise) lite.mjs:3978-3980 | droidAction lite.mjs:693-706 | sameOrigin check (403 'bad origin'), drain body, `docker start redroid` (20s), `adb connect 127.0.0.1:6555` (5s), 303 -> /device?dv=mobile |
| E-03 | /droid/stop | POST | droidAction lite.mjs:693-706 | `adb disconnect` (5s), `docker stop redroid` (30s), 303 -> /device?dv=mobile |
| E-04 | /watch/start | POST (405 otherwise) lite.mjs:3982-3984 | watchAction lite.mjs:581-593 | sameOrigin check; if port 6080 not up runs `systemctl start claude-qa-watch.service` (20s); resets watchCache; 303 -> /device?dv=web |
| E-05 | /watch/stop | POST | watchAction lite.mjs:581-593 | `systemctl stop claude-qa-watch.service` |
| E-06 | /droid/touchtest | any method | lite.mjs:3977 -> const TOUCHTEST lite.mjs:645-679 | static HTML touch diagnostic page (2057 B) with two canvases, touch-action none vs default; logs touch events; no auth logic besides Caddy gate |
| E-07 | /watch, /droid, /settings | any | lite.mjs:3972-3976 | 302 -> /device (drops query string and ?dv) |
| E-08 | /droidview/* | proxied | Caddyfile.template:68-73 | see 5.4 |
| E-09 | /vnc/* | proxied | Caddyfile.template:58-63 | see 5.4 |
Note: watchAction/droidAction call `execFile('systemctl', ...)` and `docker` directly, no `sudo` (lite.mjs:588, 699); the sudoers template grants `/usr/bin/systemctl start claude-qa-watch` without `.service` suffix (claude-harness.template:62-63). Whether the dashboard unit's user can run these directly: not verified.

### 5.4 Caddy routes
- `(gauth)` Caddyfile.template:35-55: sets HSTS, nosniff, `Content-Security-Policy "frame-ancestors 'self'"` (L40), Referrer-Policy same-origin; `forward_auth 127.0.0.1:4180` (oauth2-proxy), 401 -> redirect to `https://{{DOMAIN}}/oauth2/start?rd=...`.
- `(vncproxy)` L58-63: `handle /vnc/* { uri strip_prefix /vnc; reverse_proxy 127.0.0.1:6080 }`. So `/vnc/vnc.html` -> websockify `/vnc.html`; the page's `path=vnc/websockify` makes the WS URL `wss://host/vnc/websockify` -> stripped to `/websockify` (explained lite.mjs:828-830).
- `(droidproxy)` L68-73: `handle /droidview/* { uri strip_prefix /droidview; reverse_proxy 127.0.0.1:8000 }`. Comment L65-67 says it lets "/droid page" iframe the stream same-origin.
- Both snippets imported (after `gauth`, before `sse`) in the primary vhost `{{DOMAIN}}` (L112; imports L128-129) and in the `{{EXAMPLE_SUB}}.{{DOMAIN}}` vhost (L161; imports L169-170).
- `droid.{{DOMAIN}}` vhost L181-188: `encode zstd gzip; route { import gauth; reverse_proxy 127.0.0.1:8000 }` - raw ws-scrcpy, no strip_prefix; comment L176-180 calls it the full-page escape hatch. The dashboard's "Console" button points at `/droidview/` (lite.mjs:732), not this vhost; droid/SETUP.md:105 mentions a "`⧉ console` chip on /device" (label text differs from the code's "Console").
- Dashboard's own CSP for these server-rendered pages: `BASE_CSP` = base-uri none; object-src none; form-action 'self'; frame-ancestors 'self' (lite.mjs:2576). No frame-src/script-src on /device (lite.mjs:2574, comment). `/ui` uses a stricter nonce CSP with `frame-ancestors 'none'` (lite.mjs:3798-3808), but /device does not go through it.
- Ports: 6080 websockify, 5901 x11vnc (-localhost), 9222 Chrome CDP, 8000 ws-scrcpy, 6555 redroid adb (host side of -p 127.0.0.1:6555:5555, droid/SETUP.md:33), 8886 ws-scrcpy server-side `tcp:8886` remote (lite.mjs:742; meaning of 8886 not verified).

### 5.5 Client JS inlined for this page
- `remoteKeysScript()` lite.mjs:827-846; the `<script>` body is L832-845, 1486 B. Plain inline `<script>` without a nonce (page() path, not /ui); emitted only when Web segment and watch is up (lite.mjs:881, 899).
  - Helpers: `_v()` = getElementById('vf') (L833); `_w()` = iframe contentWindow (L834); `nb(id)` clicks a noVNC DOM element (L835); `k(sym,code)` -> `rfb.sendKey` (L836); `nav(back)` sends Alt+Left/Right (L837); `kb()` clicks `noVNC_keyboard_button` and focuses `noVNC_keyboardinput` (L838); `pv/fbk/pst` paste: `navigator.clipboard.readText` -> `rfb.clipboardPasteFrom` then Ctrl+V keys after 90ms, `prompt()` fallback (L840-842).
  - **`_x()` noVNC loader**, L843 (one line, ~190 B): reads same-origin iframe `contentDocument`, appends `<script type=module>` with `import UI from './app/ui.js'; window.rfb = UI.rfb;` so the parent gets noVNC's live RFB object via the ES-module singleton. `setInterval(..., 1200)` retries until `_w().rfb` exists then clears (L844). Depends on noVNC's `app/ui.js` exporting `UI.rfb` (not verified against the installed novnc version).
- Full-screen toggle: single inline onclick attribute, lite.mjs:892.
- Touch handling in the dashboard itself: none for the embedded streams (touch handled inside ws-scrcpy and noVNC). Touch code in this repo: `TOUCHTEST` page script (lite.mjs:645-679, 2057 B whole template) and ws-scrcpy.patch changes to `InteractionHandler.ts` / `TouchControlMessage.ts` (iOS force clamp, ws-scrcpy.patch:1-14, 52-82; rationale droid/SETUP.md:66-74).
- Page-wide JS also loaded by `page()` (not device-specific): lite.mjs:2444-2552 (not itemised).

### 5.6 Not verified / gaps
- Contents of the six ws-scrcpy.patch hunks beyond headers/SETUP.md summary (patch not read line by line); the actual built ws-scrcpy at ~/redroid not inspected.
- Runtime behaviour (no browser run, no service state checked); whether redroid/ws-scrcpy/claude-qa-watch exist or are running on this box.
- qa-watch/SETUP.md lines 41-end (MCP snippet etc.) not read; sudoers file read at 2 lines only.
- Whether dashboard user can call `systemctl`/`docker`/`adb` without sudo as lite.mjs does.
- noVNC version / `ui.js` export shape; meaning of `tcp:8886`.
- Line numbers after ~L1000 in lite.mjs may have shifted since the file was being edited by someone else mid-mapping (see snapshot).
- No `.service` for `claude-dash-lite` consulted for how the dashboard runs the commands (infra/dashboard/claude-dash-lite.service.template exists, 1.4K, not read).


## 6. Existing gates and probes
Paths are relative to the repo root (mows-harness). "Observed" = I ran it on this box (node v22.23.2, 2026-10-11); everything else is read from code.
Not run by me: e2e-infra, e2e-agents, probes, coverage tools, mobile-journey, selfcheck, journeys (see 6.6).

### 6.1 Inventory
| id | check | file:line | what it asserts | runs where | needs | exit decided? |
|---|---|---|---|---|---|---|
| G-01 | preflight 5b vendor hashes | scripts/preflight.sh:126 | `sha256sum -c SHA256SUMS` inside infra/dashboard/app/vendor (6 files: 4 .mjs + 2 .woff2, SHA256SUMS) | preflight, ci.yml:21 | sha256sum | y (bad -> :313) |
| G-02 | preflight 5b ext agreement | preflight.sh:133-137 | the ext list parsed from lite.mjs `UI_ASSET_TYPES` (sed range at :133) must equal literal `css mjs woff2 ` | preflight | sed/grep | y |
| G-03 | preflight 5b size ceiling | preflight.sh:138-152 | sum of per-file `gzip -9` over `find infra/dashboard/app -type f (*.mjs|*.css|*.woff2)` <= 158720 B | preflight | gzip | y |
| G-04 | preflight 5b dir exists | preflight.sh:125,153-154 | `[ -d infra/dashboard/app ]`, else FAIL "did not run" | preflight | - | y |
| G-05 | preflight 5c chat-view XSS gate | preflight.sh:168-184 | runs scripts/chat-view-check.mjs; FAILS (not skips) if node missing / < 22.15 / script missing | preflight, ci.yml:21 | node >= 22.15 (:171) | y |
| G-06 | preflight 5d capability honesty gate | preflight.sh:195-209 | runs scripts/capability-check.mjs; FAILS if python3+PyYAML missing | preflight, ci.yml:21 (apt python3-yaml, ci.yml:14) | node >= 22.15, python3, PyYAML | y |
| G-07 | preflight 5e panel-claims | preflight.sh:274-290 | each of 6 patterns (:281-286) still present in agents/bin/mows-agent; requires BOTH agents/bin/mows-agent AND infra/dashboard/app/views/capability.mjs to exist (:274), else FAIL (:289) | preflight | grep | y |
| G-08 | preflight 5e e2e-assertion lint | preflight.sh:220-262 | (a) no `chk ... 'true'/':'` (:225), no `|| true` tail (:228); (b) no `timeout N curl -w` (:237); (c) no duplicate `chk "label"` in 4 e2e scripts (:244-248); (c2) no duplicate `check('label'` in capability-check.mjs and chat-view-check.mjs (:256-262) | preflight | grep | y |
| G-09 | preflight 3 forbidden strings | preflight.sh:34-39 | see 6.4 | preflight | git | y |
| G-10 | preflight 3b IPv4 shape | preflight.sh:48-60 | any dotted-quad other than 127.0.0.1 / 0.0.0.0 / 255.255.255.255 in a tracked file | preflight | git | y |
| G-11 | preflight 3c control bytes | preflight.sh:79-89 | no byte in [\x00-\x08\x0B-\x1F\x7F] in any tracked file that is valid UTF-8 (woff2/png skip) | preflight | iconv, grep -P | y |
| G-12 | preflight 4 / 4b | preflight.sh:92-94, 102-113 | only 10 sanctioned `double-brace placeholder` names; commit author/committer not a personal-mail domain; commit messages pass the 6.4 pattern | preflight | git history (ci.yml:8 fetch-depth 0) | y |
| G-13 | preflight 1 / 2 | preflight.sh:7-18 | tracked files == scripts/manifest.txt (both directions); no nested .git, .DS_Store, *.bak*, *.pyc, *.so, *.sqlite*, __pycache__ | preflight | git | y |
| G-14 | preflight 5 / 6 / 7 / 8 | preflight.sh:116-121, 293, 296-300, 303-311 | bash -n + shellcheck -S error on tracked shell; gitleaks if installed; install.sh dry-run in throwaway HOME; `--container` docker install (manual flag only) | preflight (8: manual) | shellcheck, gitleaks, docker (8) | y |
| G-15 | chat-view-check.mjs | scripts/chat-view-check.mjs:1-657 | imports REAL app/views/chat.mjs (`renderPartial`, `reconcile`, :33) + vendor/marked.mjs (:35); markdown, hostile-input inertness, 6000-case fuzz (:425-545), reconcile (:544-655). Observed: 91 PASS, rc 0 | preflight 5c; e2e-agents.sh:732-733; manual | node >= 22.15 (`registerHooks` :15) | y (:657) |
| G-16 | capability-check.mjs | scripts/capability-check.mjs:23-43,967 | imports infra/dashboard/capability.mjs + app/views/capability.mjs (`CapabilityPanel`); walks the vnode tree; runs real agents/bin/mows-agent-meta via python3 (:697,914). Observed: 170 PASS, rc 0 | preflight 5d; manual | node >= 22.15, python3+PyYAML | y |
| G-17 | chat-stream-utf8-check.mjs | scripts/chat-stream-utf8-check.mjs:9-53 | server-side `wireChatStream` (infra/dashboard/chat-stream.mjs): UTF-8 split across chunks, malformed-line drop count. Observed: 4 PASS | e2e-agents.sh:726-727 only (NOT preflight, not e2e-infra) | node | y |
| G-18 | stream-cap-check.mjs | scripts/stream-cap-check.mjs:16-90 | SSE_MAX read from lite.mjs (:22); SSE_MAX clients 200, next 503 + Retry-After, slots reclaimed | e2e-infra.sh:172; path filter e2e-infra.yml:22 | node (20 in container), live dashboard on PORT (default 3105) | y |
| G-19 | stream-replay-check.mjs | scripts/stream-replay-check.mjs:1-77 | Last-Event-ID replay resumes w/o dup; no cross-agent leak via spoofed Last-Event-ID; rejected replay keeps conn alive; needs server `MOWS_TEST_HOOKS=1` (:13-21) | e2e-infra.sh:176 | same | y |
| G-20 | csp-admits.mjs | scripts/csp-admits.mjs:20-92 | fetches a URL; checks nonced elements vs header nonce, inline style attrs, on* attrs, off-origin src/href; prints JSON, exit 1 if `refused` non-empty | e2e-infra.sh:288 (invoked with `|| true`; the verdict comes from the jq chk at :290-303) | node stdlib | n at call site (jq decides) |
| G-21 | chat-view-coverage.mjs | scripts/chat-view-coverage.mjs:19-298 | mutation sweep (36 `{ id:` entries) of views/chat.mjs + vendor/marked.mjs via literal find/replace, re-runs G-15; `--self-test` | manual (grep finds no caller in preflight/ci/e2e) | node >= 22.15; WRITES source files in place | y per header :19 (not run) |
| G-22 | capability-coverage.mjs | scripts/capability-coverage.mjs:12-504 | same for capability.mjs, app/views/capability.mjs, mows-agent-meta, fixtures (104 `{ id:`) | manual | node >= 22.15, python3 | y per header (not run) |
| G-23 | e2e-infra.sh assertions | scripts/e2e-infra.sh:83-450 | 84 `chk` invocations (2 inside a 4-iteration loop :207-210, so 90 executed; V1b/V2 recount). /api (:89-154), /stream (:155-176), /ui chrome + twin (:195-220), doc ceiling (:231-234), speculation rules (:244), /ui CSP (:259-323), webhooks (:325-366), Caddy/oauth (:374-417), HTTP/2 (:429-442, SKIPs w/o MOWS_HOST), RSS (:448-450) | e2e-infra.yml:70; manual `./scripts/e2e-infra` | docker + network; container node 20 (scripts/e2e-infra:26); MOWS_HOST optional | y (:456) |
| G-24 | scripts/e2e-infra wrapper | scripts/e2e-infra:20-36 | `docker run ubuntu:24.04`, installs ttyd/caddy/oauth2-proxy/node20, `cp -r /src /r`, runs e2e-infra.sh | e2e-infra.yml:70 | docker, network, MOWS_HOST (env) | y (last cmd's rc) |
| G-25 | e2e-agents.sh dashboard bits | scripts/e2e-agents.sh:725-733 | only two dashboard assertions: G-17 and G-15 (223 `chk` invocations total, rest are agents layer; V1b recount) | ci.yml:26; manual | node >= 22.15 (G-15) | y (:794) |
| G-26 | probes (run.sh/probes.mjs/proxy.mjs/fixture.sh) | docs/qa/probes/* | real-browser /ui probes, 6 modes (6.3) | manual only; README:9-14 says "not a gate", preflight must not call them | docker, Playwright (SKIPs w/o), network first run | y (probes.mjs:144; SKIP = exit 0 :60) |
| G-27 | journeys | docs/qa/journeys/agent-chat.md, agents-tab.md | NL steps for the `qa` skill; both `mode: headless`, `target: http://127.0.0.1:3005` (frontmatter :2-3) | manual `/qa run` | MCP browser, a runnable dashboard | n (agent-judged) |
| G-28 | ci.yml | .github/workflows/ci.yml:1-26 | on push+PR, no path filter: gitleaks action, apt shellcheck+python3-yaml, setup-node 22 (:20), `./scripts/preflight.sh`, `bash scripts/e2e-agents.sh` | CI | ubuntu-24.04 | y |
| G-29 | e2e-infra.yml | .github/workflows/e2e-infra.yml:15-72 | push/PR path-filtered (`infra/**`, install.sh, scripts/e2e-infra*, `scripts/stream-*.mjs`, itself), nightly cron :36, dispatch; timeout 20 min (:41); MOWS_HOST from `secrets.` (:72) | CI | docker | y |
| G-30 | web-term-selfcheck.sh | infra/webconsole/web-term-selfcheck.sh:9-78 | web-term.sh `switch`: exit 0 + prints target, exit 2 unknown tabid, exit 3 bad target, with a real pty tmux client; terminal only, no /ui | manual (infra/SETUP.md:306); not in CI/preflight | tmux, `script`, bash | y (:78) |
| G-31 | mobile-journey.mjs | infra/webconsole/mobile-journey.mjs:1-244 | phone geometry of the SERVER-RENDERED dashboard (`/`, `/settings`, `/watch`, `/droid`, `/app`) and the terminal page (term-index.html served in place of /term/); 4 phones; claims 114 assertions (infra/SETUP.md:315, not counted by me); never loads /ui | manual (infra/SETUP.md:309-313) | Playwright-core in ~/.npm/_npx + a Playwright chromium (:23-25, exit 2 if absent), tmux, running dashboard on DASH | y (:244) |

### 6.2 Numeric ceilings currently enforced
| id | ceiling | value | measured how | file:line |
|---|---|---|---|---|
| C-1 | client assets, gzip -9 per file, summed | <= 158720 B (= 76800 code + 81920 fonts, :142-145). Observed now 130776 B; script prints fonts as the literal "79709B" (:152, hard-coded, not measured) | `gzip -9 -c "$f" \| wc -c` summed over `find infra/dashboard/app -type f \( -name '*.mjs' -o -name '*.css' -o -name '*.woff2' \)` | scripts/preflight.sh:138-151 |
| C-2 | served GET /ui document, gzip -9 | <= 20480 B (comment :228: 16,105 B measured; docs/architecture.md:366: ~16,750) | `curl -s http://127.0.0.1:3005/ui \| gzip -9 -c \| wc -c` | scripts/e2e-infra.sh:231-234 |
| C-3 | dashboard RSS | <= 153600 KB (150 MB) | `ps -o rss= -p $DASH_PID` after the whole suite ran | scripts/e2e-infra.sh:448-450 |
| C-4 | concurrent SSE | SSE_MAX = 8; 9th gets 503 + `retry-after: 30` | stream-cap-check opens SSE_MAX+1 sockets | infra/dashboard/lite.mjs:2746,2828; scripts/stream-cap-check.mjs:22-76 |
| C-5 | node floor for gates | >= 22.15 | `process.versions.node` compare | scripts/preflight.sh:171 |
| C-6 | nonced elements in /ui | exactly 3 (inline style, import map, module script) and `wrongNonce == 0`, `offOrigin == 0`, `styleAttrs == 0`, `eventAttrs == 0` | csp-admits JSON via jq | scripts/e2e-infra.sh:290-303 |
| C-7 | CI job timeout | 20 min | - | .github/workflows/e2e-infra.yml:41 |
| C-8 | SSE reconnect wait in probe | 60 x 500 ms | poll loop | docs/qa/probes/probes.mjs:252 |
Stale copies of C-1/C-2 in prose: lite.mjs:36-39 and README.md:481 say 76,800 B; docs/architecture.md:365-366 says "45,494 B of 76,800 B". The script (:151) is the live value.

### 6.3 Probes in docs/qa/probes/probes.mjs (`node probes.mjs <mode> <chromium|webkit>`; dispatch :128-135; one `RESULT[engine/mode]` line at :143)
Selectors the probes hard-depend on: `a[href^="/ui/agents/"]`, `.chatbox`, `.chat .chatf textarea`, `.chat .chatf button`, `.m.claude.streaming .mb`, `.m.me`, `.m.claude .mb`, `button.jump`, `.cherr`, `.termfab`, `.agchat`, `nav.tabs`, `header.hdr`, `.agback-in`. Test hooks: `/_test/chat`, `/_test/chatend` (probes.mjs:80-87; lite.mjs:3902-3919, gated on MOWS_TEST_HOOKS=1).
- **journey** (147-321, 23 `check(` lines; maps agent-chat.md steps 1-9). Step 1 boot: import map + bare specifiers + agents list (150-153); agent page has chatbox + one composer (155-158). Steps 2-5: 3 injected deltas, live bubble length strictly increasing (160-172). Steps 6-7 (174-203): 40 paragraphs overflow precondition; scrolled up at top -> next token does NOT move scrollTop (<40); exactly one `button.jump`; jump returns to bottom (<40px); follows new tokens again. Step 8 (205-222) at 375x812: no horizontal scroll, `visualViewport` exists, composer bottom <= visual viewport. Second viewer (224-240): tab 2 receives later tokens, tab 1 unaffected, tab 2 holds a strict suffix. Reconnect (242-271): proxy cut (proxy.mjs), delta injected during outage not delivered, then recovered within 30 s, exactly once in both tabs, pre-cut text survived. Step 9 (274-290): saveTurn + endTurn, reply on screen exactly once, no `.cherr`, reload shows it exactly once. Console (292-319): no uncaught errors; regexes `cutNoise` (:294) and `knownEngineNotes` (:308, the WebKit `interactive-widget` message) are NOTEd not failed. Differs from md: step 3 types a real message, probe injects deltas; md step 9 says "reload mid-stream", probe reloads after end.
- **lost** (323-371, journey step 10): send unsaved message; `you` bubble appears, never disappears over 120 x 25 ms samples (=3 s window), `.cherr` matches /was not saved/ and /until the transcript reloads/, text handed back to composer, button not disabled, gone after reload.
- **repeat** (373-397; run.sh seeds the transcript user turn as `status?`): one saved `status?` at start; repeat send keeps 2 bubbles, warns, hands text back; next different send retires the old one (1 `status?`), alert is about the new message, exactly 2 user bubbles.
- **csp** (399-432): SPA still renders; injects `onerror` via innerHTML, inline `<script>`, off-origin `<script>`; with `MOWS_QA_CSP_EXPECT` unset it expects none ran and >0 `securitypolicyviolation` events; `=runs` inverts (control build, :400). Not set by run.sh.
- **base** (434-467): `/`, `/agents`, `/history` return 200/302/303 through the proxy, zero CSP violations, body background computed non-transparent.
- **layout** (469-559): viewports 375x812, 414x896 (phone), 800x700 (tablet), 1024x800, 1400x900 (desktop) on /ui/agents/harness-reviewer (loop :524). Per viewport 4 checks: precondition (phone: `.termfab` rendered 0x0; else Send.right <= fab.left), no FAB/Send box overlap, `elementFromPoint` at Send centre is Send, correct nav rendered (phone: `nav.tabs` + `.agback-in` shown and `header.hdr` hidden; >=701: header shown, tabs hidden). Depends on `.chatbox` min-height set via CSSOM (~:489).

### 6.4 Forbidden-string / leak gate (what a NEW tracked spec file must not contain)
Scope: `git grep -nIE` over tracked files only, minus scripts/preflight.sh itself (preflight.sh:39). An untracked new file is invisible until `git add`; once added it must also be in scripts/manifest.txt, which lists every file individually (preflight.sh:10-14; docs entries at manifest.txt:96-142 after 87dc0ca).
Public pattern (preflight.sh:34): `ctx7sk-`, `ntn_`, `ghp_`, `github_pat_`, `sk-ant-`, `AKIA`, `mongodb+srv://`, `client_secret=`, `/opt/homebrew`, `/Users/`, `/home/` followed by one or more `[A-Za-z0-9_-]` (the absolute-home-path shape). These are plain substrings: even prose naming them trips the gate. NOTE this map names them verbatim, so do not paste it unedited into a tracked file. <!-- preflight-allow -->
Local pattern: `scripts/preflight-local.pat`, gitignored (.gitignore), ONE ERE alternative per line (preflight.sh:35-38; format header file:1-13). Its lines (file:16-29, 33) hold this box's real IP, reference domain, org/product names, host/account ids; I deliberately do not copy them here. Read the file before writing prose that names orgs or hosts. CI has only the public half.
IPv4 (preflight.sh:48-60): any `N.N.N.N` except 127.0.0.1, 0.0.0.0, 255.255.255.255 (e.g. a 4-part version string trips it). Placeholders (:92-94): any `double-brace UPPER_SNAKE placeholder` (no spaces) must be one of DOMAIN, EXAMPLE_SUB, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, COOKIE_SECRET, ADMIN_EMAIL, CONTEXT7_API_KEY, VPS_HOST, PROJECTS_ROOT, ADMIN_USER. Control bytes (:79-89): only tab/LF allowed.
Allow marker: the literal text `preflight-allow` anywhere on the same line; implemented as `grep -v 'preflight-allow'` on the hit lines (:39, :59, :111). Works for 3, 3b and the commit-message scan; there is NO allow marker for placeholders (:94), control bytes (:84), author identity (:106-109) or manifest. Existing use: claude/skills/sync-to-vps/sync.py:47-53, SKILL.md:53 (as an HTML comment).
Commit metadata (:102-113, `git log --all`): author/committer with @gmail/@outlook/@yahoo/@hotmail/@icloud/@proton fails; messages are scanned with PAT too. Attribution trailers in this session's commits are not matched by PAT.
Observed baseline: with the local pattern file present, `./scripts/preflight.sh` is BLOCKED right now at check 3 and 4b only (existing org-name hits in agents/examples/<agent>.md, docs/superpowers/specs/2026-09-20-agent-souls-pr-reviewers-design.md, docs/superpowers/plans/2026-09-20-agent-souls-pr-reviewers.md, scripts/e2e-agents.sh:631, and in 2 commit messages); everything else passes (5b 130776 B, 5c 91, 5d 170). The public pattern alone: 0 hits in tree and in history (same grep, observed).

### 6.5 Fixture (docs/qa/probes)
- run.sh:15 ports: dashboard 3905 (host side, `-p 127.0.0.1:3905:3005`, :33), proxy 3906, cut-control 3907; container name `mows-qa-ui` (:16); image `node:20-slim` (:34); repo mounted read-only at /r, probes dir at /probes (:34). Not 3005/3105 so it cannot collide with a live or dev dashboard (:14).
- Per mode a fresh container (`up` calls `cleanup` first, :32; `all` runs journey lost repeat csp base layout, :67); seed `hello`, `status?` for repeat (:47); readiness: poll proxy `/ui` up to 30 x 1 s (:37-40); EXIT/INT/TERM trap removes proxy + container (:27). Fails if the probe printed no `RESULT[` line (:58-61).
- proxy.mjs:14-33: TCP pass-through LISTEN->UPSTREAM; any request to the control port destroys every live socket (reconnect test; not `ctx.setOffline()`, :3-7).
- fixture.sh (runs in container): demo user home built as `['', 'home', 'demo']` to dodge preflight (:12); one session jsonl (:14); agents/examples/harness-reviewer.md installed (:16); one done run `20260916-101500-1` with status.json + out.txt (:18-24); chat.jsonl with a user turn (seed) + assistant turn (:29-32); starts `HOME=$DH MOWS_TEST_HOOKS=1 node /r/infra/dashboard/lite.mjs --port 3005 --host 0.0.0.0` (:36). No runuser, no mows-agent, no python in the image, so every send takes the early-exit path (:6-10). No Playwright is installed by run.sh; probes.mjs finds it via `$PLAYWRIGHT`, bare import, or ~/.npm/_npx (probes.mjs:29-47).
- e2e-infra.sh fixture (separate): same demo home, harness-reviewer + `ghost` agents, run `20260917-010203-99`, systemctl shim, dashboard on 3005 (:12-75, :88-103).

### 6.6 Not verified / gaps
- Not run by me: e2e-infra (needs docker+network), e2e-agents, probes (Playwright/docker), coverage tools (they rewrite source in place), mobile-journey, selfcheck, the journeys. Pass counts in e2e-infra.yml:46-48 ("90 passed") and ci.yml:22 ("145 assertions") are comments, not re-measured; e2e-agents.sh has 220 `chk` lines now.
- e2e-infra.yml path filter (:17-23, :25-31) does not list scripts/csp-admits.mjs, scripts/chat-view-*.mjs or docs/qa/**; `infra/**` and `scripts/stream-*.mjs` are the only code triggers besides the scripts themselves. Nightly cron covers the rest.
- e2e-infra container uses node 20 (scripts/e2e-infra:26); G-15/G-16 need 22.15, so they cannot run there; they run on the CI runner (setup-node 22) and locally.
- Coverage tools G-21/G-22 have no caller in preflight, ci.yml or any e2e script (grep over *.sh/*.yml/*.md/*.mjs, excl. docs/superpowers and tasks).
- No gate renders /ui in a browser in CI; probes are manual (README:9-14). The `qa` journeys are manual too. csp-admits is explicitly "not a browser" (csp-admits.mjs:12-16).
- Journey md steps and probe steps are not 1:1 (see 6.3 journey note). agents-tab.md targets server-rendered `/` and `/agents`, not /ui.
- mobile-journey's 114-assertion claim and its pass state not verified. It and G-30 touch only server-rendered pages / terminal, never infra/dashboard/app.

### Gates that would break if infra/dashboard/app/ were replaced by a built dist/ (facts from the code)
1. G-04/G-01: preflight.sh:125,153 FAIL if `infra/dashboard/app` is absent; :126 `cd infra/dashboard/app/vendor && sha256sum -c SHA256SUMS` FAILs if that dir or file is absent.
2. G-03: measures only `*.mjs|*.css|*.woff2` under infra/dashboard/app (:141). A dist with `.js`, `.map`, `.svg`, `.json`, `.png` is unmeasured there AND unservable: lite.mjs:3722-3726 serves only those 3 ext and 404s the rest (comment :3711-3721). G-02 (:137) hard-requires the served list == `css mjs woff2 `, so adding an ext means editing lite.mjs and preflight together.
3. G-05, G-16, G-25: chat-view-check.mjs:14,33,35 and capability-check.mjs:29,44 import SOURCE files by fixed path `infra/dashboard/app/views/{chat,capability}.mjs` and `app/vendor/{preact,hooks,htm,marked}.mjs` through a bare-specifier resolve hook (chat-view-check.mjs:19-31), expecting named exports `renderPartial`, `reconcile`, `CapabilityPanel`. A bundle, a renamed dir, or a path move breaks them.
4. G-07: preflight.sh:274 requires `infra/dashboard/app/views/capability.mjs` to exist, else FAIL (:289).
5. G-21/G-22 (manual): FILES (chat-view-coverage.mjs:29-33, capability-coverage.mjs:22-28) and literal find/replace strings target un-minified source in app/views/*.mjs and vendor/marked.mjs; an unapplied mutation poisons the run (header :14-18).
6. G-13/G-09..G-11: a tracked dist is scanned file by file for forbidden strings, IPv4 shapes and control bytes, and each file must be listed in scripts/manifest.txt (currently app files at manifest.txt:154-167). Untracked/gitignored dist is not scanned but then also not present for G-03 unless built first.
7. G-23: e2e-infra.sh:150-151 greps the served `/ui/` HTML for `views/capability` (comes from the per-file import-map entries lite.mjs:3845-3849); :300-301 requires exactly 3 nonced elements (style, import map, module script; shell at lite.mjs:3861-3867); :231-234 measures the whole served doc against 20480 B. The container does `cp -r /src /r` (scripts/e2e-infra:35) so dist must be in the tree or built there.
8. lite.mjs itself: `UI_DIR = ./app/` (:3702); a missing dir is swallowed by `catch {}` (:3741) and /ui serves a blank page (header :49-51); shell hardcodes `vendor/preact|hooks|htm|marked.mjs` specifiers (:3832-3835), `main.mjs` entry (:3867) and two vendor woff2 names (:3760-3761).
9. G-26 probes: run.sh mounts the repo and serves whatever lite.mjs serves, so they follow lite.mjs; they break only via the selectors listed at the top of 6.3 or via the CSP (nonce/inline) behaviour.
Unaffected by app/ (server-only or terminal-only): G-17, G-18, G-19, G-20 (reads served HTML, so see 7), G-30, G-31.


# 07 Baseline (current UI), measured 2026-10-11 ~02:15-02:17 UTC, host 127.0.0.1:3005 (lite.mjs)
Measured with commands in 7.7. S=scratchpad dir; `sz.sh` = the node zlib one-liner wrapped to take a URL path or file.
Caveat: dynamic docs (/, /history, /system, /agents) change a few bytes between fetches (live session data); numbers are one sample.
Caveat: server gzips HTML only when `Accept-Encoding` is sent; it sends NO compression for .mjs/.js/.woff2/.webmanifest even with `Accept-Encoding: gzip, br` (7.1 "wire" column).

### 7.1 transfer sizes
All status 200. raw / gz9 / br are bytes of the identity body piped through node zlib. "wire" = bytes actually sent by the live server with `Accept-Encoding: gzip, br` (curl size_download).

| URL | raw | gzip-9 | brotli | wire (live server) | cache-control |
|---|---|---|---|---|---|
| / | 79128 | 15956 | 13858 | 16010 (gzip) | no-cache |
| /history | 86072 | 17328 | 14923 | 17409 (gzip) | no-cache |
| /system | 64508 | 15931 | 13934 | 15973 (gzip) | no-cache |
| /device | 60636 | 15129 | 13215 | 15170 (gzip) | no-cache |
| /agents | 58939 | 14668 | 12828 | 14704 (gzip) | no-cache |
| /ui | 50964 | 11471 | 10107 | 11513 (gzip) | no-cache |
| /ui/agents | 50964 | 11477 | 10107 | 11512 (gzip) | no-cache |
| /md?f=.../mows-harness/README.md | 103983 | 29815 | 25883 | 29861 (gzip) | no-cache |
| /manifest.webmanifest | 460 | 256 | 205 | 460 (none) | no-cache |
| /fleet.js | 8870 | 3742 | 3166 | 8870 (none) | public, max-age=300 |
| /apple-touch-icon.png | 1046 | 899 | 858 | 1046 | max-age=86400 |
| /favicon.png | 273 | 296 | 277 | 273 | max-age=86400 |
| /ui/assets/main.96e096ea.mjs | 2582 | 1188 | 961 | 2582 (none) | immutable 1y |
| /ui/assets/store.514f909f.mjs | 1899 | 1022 | 835 | 1899 | immutable 1y |
| /ui/assets/ui.77515055.mjs | 566 | 307 | 266 | 566 | immutable 1y |
| /ui/assets/vendor/preact.bc73fc81.mjs | 11429 | 4683 | 4294 | 11429 | immutable 1y |
| /ui/assets/vendor/hooks.cd676764.mjs | 3729 | 1564 | 1428 | 3729 | immutable 1y |
| /ui/assets/vendor/htm.33dd277.mjs | 1207 | 652 | 577 | 1207 | immutable 1y |
| /ui/assets/vendor/marked.7ceae866.mjs | 92829 | 18351 | 16102 | 92829 (none) | immutable 1y |
| /ui/assets/views/agents.79a312a9.mjs | 11096 | 4592 | 3834 | 11096 | immutable 1y |
| /ui/assets/views/capability.1261946b.mjs | 12780 | 5106 | 4241 | 12780 | immutable 1y |
| /ui/assets/views/chat.3ab182f7.mjs | 32523 | 12954 | 10990 | 32523 (none) | immutable 1y |
| /ui/assets/views/runs.5d31681c.mjs | 839 | 471 | 411 | 839 | immutable 1y |
| /ui/assets/vendor/inter-var-latin.19416575.woff2 | 48256 | 48254 | 48260 | 48256 | immutable 1y |
| /ui/assets/vendor/jetbrains-mono-var-latin.810bbf11.woff2 | 31432 | 31460 | 31436 | 31432 | immutable 1y |
| /opt/claude-dashboard/term-index.html (file, 771724 B on disk; mode root) | 771724 | 210600 | 154172 | not measured: served by Caddy, public host off-limits | n/a |

/ui and /ui/agents return the same shell (identical raw size; the CSP nonce differs per response). All 11 /ui modules are loaded on a /ui visit: main statically imports ui, views/agents, views/runs; agents imports capability, chat, store; chat imports marked; preact/hooks/htm come via the import map (checked with `grep -oE "from ['\"][^'\"]+['\"]"` on each module).

Page-load totals (document + statically referenced subresources; the two fonts are counted though the browser fetches a woff2 only if glyphs use it; /events SSE and runtime /z beacons, /api fetches excluded):

| page load | raw | gzip-9 | brotli | wire as served today (HTML gzip, rest identity) |
|---|---|---|---|---|
| `/` = doc + fleet.js + manifest + 2 icons + 2 fonts | 169465 | 100863 | 98060 | 106347 |
| `/ui` = doc + 11 modules + manifest + 2 fonts | 302591 | 142331 | 133947 | 263140 |
| `/ui/agents` | same asset set as /ui | | | 263139 (doc 11512 instead of 11513) |

Arithmetic: `/` wire = 16010+8870+460+1046+273+48256+31432. `/ui` wire = 11513+171479 (11 modules, raw sum)+460+79688 (fonts). JS-only portion of /ui: raw 171479, gz 50890, br 43939 (marked alone = 92829 raw, 54% of module bytes).
Fonts are 79688 B of both pages and are incompressible; `/` ships no JS framework (8870 B fleet.js, inline CSS/JS in the 79 KB doc).

### 7.2 TTFB
Median of 3 runs of `curl -o /dev/null -s -m 30 -w '%{time_starttransfer} %{time_total}'`, seconds (TTFB / total). Raw runs are in the command output of 7.7 item 2.

| route | runs (ttfb) | median TTFB | median total |
|---|---|---|---|
| / | 0.0446, 0.0140, 0.0132 | 0.0140 | 0.0141 |
| /history | 0.0046, 0.0016, 0.0121 | 0.0046 | 0.0047 |
| /system | 0.0080, 0.0105, 0.0012 | 0.0080 | 0.0080 |
| /device | 0.0267, 0.0301, 0.0313 | 0.0301 | 0.0301 |
| /agents | 1.1365, 1.6133, 1.3429 | 1.3429 | 1.3429 |
| /ui | 0.0014, 0.0012, 0.0012 | 0.0012 | 0.0013 |
| /ui/agents | 0.0155, 0.0109, 0.0099 | 0.0109 | 0.0109 |
| /md?f=README.md | 0.0075, 0.0057, 0.0044 | 0.0057 | 0.0058 |
| /manifest.webmanifest | 0.0028, 0.0017, 0.0010 | 0.0017 | 0.0018 |
| /fleet.js | 0.0020, 0.0020, 0.0010 | 0.0020 | 0.0021 |
| /ui/assets/main.96e096ea.mjs | 0.0049, 0.0016, 0.0012 | 0.0016 | 0.0017 |
| /healthz | 0.0018, 0.0018, 0.0012 | 0.0018 | 0.0019 |

/agents is the only slow route (1.1-1.6 s server-side; every other route <50 ms). Loopback only: excludes network, TLS, Caddy, and oauth2 proxy latency.

### 7.3 request counts
Distinct subresource URLs per document (script src, link href for icon/manifest, import-map targets, `url()` font refs in CSS, `<img src>`); `<a href>` links are not counted. Counted by grep on the served HTML (7.7 item 3).

| doc | script src | link (icon/apple/manifest) | import-map entries | fonts | img | distinct total |
|---|---|---|---|---|---|---|
| / | 1 (/fleet.js) | 3 | 0 | 2 | 0 | 6 |
| /history | 1 (/fleet.js) | 3 | 0 | 2 | 0 | 6 |
| /system | 0 | 3 | 0 | 2 | 0 | 5 |
| /device | 0 | 3 | 0 | 2 | 0 | 5 |
| /agents | 0 | 3 | 0 | 2 | 0 | 5 |
| /ui and /ui/agents | 1 (main.96e096ea.mjs, same URL as its map entry) | 1 (manifest) | 11 | 2 | 0 | 14 |
| /md?f=README.md | 0 | 3 | 0 | 2 | 5 (all external img.shields.io) | 10 (5 same-origin) |
| /opt/claude-dashboard/term-index.html | 0 (12 inline `<script>` blocks, xterm inlined) | 2 file refs (apple-touch-icon, manifest) + 1 data: icon | 0 | 0 | 0 | 2 same-origin |

Other facts: `<script type="speculationrules">` prerender (eagerness moderate) present on /, /history, /system, /device, /agents, /md; absent on /ui. Runtime connections not in the count: `EventSource('/events')` (fleet.js, returns 200 text/event-stream), `fetch('/z?...')` beacons, term page `WebSocket(wsUrl,["tty"])` + `fetch('/app/live.json')`, `/settings/term-theme.json`, `/a/switch`, `/shot`.

### 7.4 server process
- `ps -o rss,etimes,cmd -p $(pgrep -f 'lite.mjs' | head -1)`: first sample RSS 58124 kB, etimes 88297 s (~24.5 h), `/usr/bin/node /opt/claude-dashboard/lite.mjs --port 3005 --host 127.0.0.1`.
- Same command ~2 min later, after the requests of this measurement run (incl. three ~1.3 s /agents hits): RSS 87072 kB (`VmRSS 87072 kB`, Threads 11). So RSS grows ~29 MB under a short burst; idle baseline is ~58 MB, not a steady-state constant.
- `curl -s -m 30 http://127.0.0.1:3005/healthz` -> `{"ok":true,"sessions":366,"scannedAgo":29,"sseClients":1}` (second call: scannedAgo 7, sseClients 1). /healthz exposes `sseClients`; `/sys` is 404.
- Other listeners: ttyd 127.0.0.1:7681 `/` returns 404 with 173 B body (needs path/args); ws-scrcpy 127.0.0.1:8000 `/` returns 200.

### 7.5 lighthouse
Measured 2026-10-11 ~03:30 UTC by the merge step (not the §7 mapper, whose run found no runner): Lighthouse 13.5.0 CLI from `$HOME/.cache/mows-qa`, `--form-factor=mobile` (default simulated throttling: Moto G Power class, slow 4G), `--only-categories=performance`, Chromium = Playwright's arm64 build (`$HOME/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`; `/opt/google/chrome` is an x86-64 binary and does not run on this aarch64 box), loopback `127.0.0.1:3005`, one run each (no median). JSON kept at `$SCRATCH/map/lh-{home,ui-agents,history,system}.json` for this session; the numbers below are the baseline the plan's `LCP ≤ 2.5 s / TBT ≤ 200 ms` gate compares against.

| route | perf score | FCP ms | LCP ms | TBT ms | CLS | Speed Index ms | total byte weight |
|---|---|---|---|---|---|---|---|
| `/` | 1.00 | 1352 | 1652 | 0 | 0 | 1352 | 107 917 |
| `/history` | 1.00 | 1350 | 1500 | 27 | 0.019 | 1350 | 109 536 |
| `/system` | 0.99 | 1502 | 1802 | 0 | 0.007 | 2357 | 98 555 |
| `/ui/agents` | 0.94 | 1135 | **2765** | 159 | 0 | 1355 | 269 665 |

Observed: `/ui/agents` is the only route over the plan's 2.5 s LCP line today; `/` first returned `NO_FCP` (no paint inside a 45 s wait) and passed on a 60 s retry — the open `/events` SSE keeps the page from ever reaching network-idle, so any Lighthouse gate on these pages needs an explicit `--max-wait-for-load` and a retry policy.
Command (verbatim): `CHROME_PATH=<arm64 chromium> npx lighthouse http://127.0.0.1:3005<route> --form-factor=mobile --chrome-flags='--headless=new --no-sandbox' --only-categories=performance --output=json --output-path=<file> --quiet --max-wait-for-load=60000`
### 7.6 not measured
- Heap after 10 min streaming on real phones: not measured: needs physical device (manual gate).
- Transfer size of /opt/claude-dashboard/term-index.html as served by Caddy (with Caddy's own encoding): not measured: public host off-limits; only the file on disk was compressed locally.
- Transfer over Caddy/TLS/oauth2 for any route (all numbers are loopback to :3005): not measured: public host off-limits.
- Browser-side parse/exec time, frames, memory of /ui or /: not measured: no trace run.
- Concurrent SSE client count over time / per-client memory cost: not measured; only the instantaneous `sseClients:1`.

### 7.7 commands
```bash
S=$SCRATCH; B=http://127.0.0.1:3005
# helper $S/sz.sh <path|file>: curl -s -m 30 "$B$1" | node -e '<the zlib one-liner from the task>'
cat $S/sz.sh
# 1. raw/gzip9/brotli per URL (document + assets)
for p in / /history /system /device /agents /ui /ui/agents "/md?f=<repo>/README.md" /manifest.webmanifest /fleet.js /apple-touch-icon.png /favicon.png /ui/assets/main.96e096ea.mjs /ui/assets/store.514f909f.mjs /ui/assets/ui.77515055.mjs /ui/assets/vendor/preact.bc73fc81.mjs /ui/assets/vendor/hooks.cd676764.mjs /ui/assets/vendor/htm.33dd277.mjs /ui/assets/vendor/marked.7ceae866.mjs /ui/assets/views/agents.79a312a9.mjs /ui/assets/views/capability.1261946b.mjs /ui/assets/views/chat.3ab182f7.mjs /ui/assets/views/runs.5d31681c.mjs /ui/assets/vendor/inter-var-latin.19416575.woff2 /ui/assets/vendor/jetbrains-mono-var-latin.810bbf11.woff2 /opt/claude-dashboard/term-index.html; do echo "$p $($S/sz.sh $p)"; done
# 1b. status + content-type + cache-control per route
curl -s -m 30 -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' $B/ ; curl -s -m 30 -D - -o /dev/null $B/ui/assets/main.96e096ea.mjs | grep -i cache-control
# 1c. wire bytes with compression offered
curl -s -m 30 -H 'Accept-Encoding: gzip, br' -o /dev/null -w '%{http_code} wire=%{size_download}\n' $B/ ; curl -s -m 30 -D - -o /dev/null -H 'Accept-Encoding: gzip, br' $B/ | grep -i content-encoding
# asset discovery: import map + module src + fonts from the served /ui doc
curl -s -m 30 $B/ui | grep -oE '"/ui/assets/[^"]*\.mjs"' | sort -u ; curl -s -m 30 $B/ | grep -oE 'url\(/ui/assets/vendor/[^)]*\)' | sort -u
# 2. TTFB, 3 runs per route (report median)
for p in / /history /system /device /agents /ui /ui/agents "/md?f=<repo>/README.md" /manifest.webmanifest /fleet.js /ui/assets/main.96e096ea.mjs /healthz; do for i in 1 2 3; do curl -o /dev/null -s -m 30 -w '%{time_starttransfer} %{time_total}\n' "$B$p"; done; done
# 3. request counts (per saved doc file $f saved from the curl of each route)
grep -oE '<script[^>]* src="[^"]*"' $f | wc -l; grep -oE '<link[^>]*href="[^"]*"' $f | wc -l; grep -oE 'url\(/ui/assets/vendor/[^)]*\)' $f | sort -u | wc -l; grep -oE '<img[^>]*src="[^"]*"' $f | wc -l; grep -oE '<script type="importmap".*</script>' $f   # import map entries: 11 on /ui
grep -oE '(<script[^>]*src="[^"]*"|<link[^>]*href="[^"]*")' /opt/claude-dashboard/term-index.html | cut -c1-150
# 4. server process
ps -o rss,etimes,cmd -p $(pgrep -f 'lite.mjs' | head -1); grep VmRSS /proc/$(pgrep -f 'lite.mjs' | head -1)/status
curl -s -m 30 $B/healthz; curl -s -m 5 -o /dev/null -w '%{http_code}\n' $B/sys
# 5. lighthouse availability
npx --no-install lighthouse --version; npx --no-install @lhci/cli --version; ls ~/.cache/ms-playwright ~/.cache/mows-qa; df -h /
```

## 8. Stage 2 additions (V2 completeness walk, 2026-10-11)

V2 walked the repo without reading sections 1–7 first, then diffed. Rows below are merged verbatim (ids `M-01`…`M-14`) so phase specs can cite them; the count disagreements in 8.3 are recorded, not resolved — where V2 and a mapper differ (41 vs 42 dispatcher branches, 84 vs 85 `chk`), the code wins and the mapper row is annotated in place by V1a/V1b.
The consequential ones for the rebuild: **M-01** (the `web-term.sh` picker renders inside the terminal — its prompts and 2 s re-attach window are part of the xterm contract), **M-02** (`claude-tmux.service` is why restarting ttyd is safe), **M-06** (the visual-parity baseline covers only `/`, `/system`, `/md` at 390 and `/` at 1280 — `/history`, `/s/*`, `/device`, `/agents*`, `/ui/*`, `/term` have no baseline image yet), **M-07/M-08/M-09** (the `/ui` view markup and copy that the chat/capability gates assert), **M-10** (the prior specs and `tasks/lessons.md` are the authority the SPA comments cite), **M-13** (a11y attributes are not inventoried).

### 8.1 Missing from sections 1–7 (new rows, each cited)
| id | area (§) | what | file:line | why a rebuild must know it |
|---|---|---|---|---|
| M-01 | §4 terminal | The `web-term.sh` text picker is a user-visible UI the map never describes (§4.3 lists only mode names). Menu `menu()`: banner "Claude Code — <host>", `LIVE terminals (attach)` rows `[aN]`, `RECENT Claude sessions (resume)` rows `[N]` (12 newest across profiles, excludes `*-observer-sessions`, tag `<- LIVE, re-attaches`), footer `[Enter] re-attach <tab's session> / [n] new / [s] shell / [q] quit`; `do_new` prompts (profile, directory abs-or-under `$PROJECTS_ROOT`, "create it? [y/N]", then `cc <profile> <dir>`); `run_session` crash wrapper in the tmux window (exit!=0 prints "ended unexpectedly … [r] resume here again", loops; passes `--strict-mcp-config --mcp-config <cfg>/mcp-interactive.json` if present); sticky re-attach "↩ re-attaching <name> — press any key for the menu…" with a 2 s `read -t 2` window (only if session detached); OSC 2 title stamps (`picker · <host>`); `list` output format `%F %H:%M profile sid8 cwd`; `resolve` output `profile<TAB>cwd<TAB>fullsid` | web-term.sh:100-116 (recent), 118-134 (resolve), 162-178 (run_session), 180-199 (do_new), 201-241 (menu), 243-245 (list), 260-269 (menu mode), 313-323 (sticky + loop) | D-U4 rebuilds the page over the same ttyd socket; this script's stdout/stdin prompts render INSIDE the new xterm, so its key set, ANSI/OSC output and 2 s timeout are part of the contract. The map's B-/T- rows describe the page blocks only |
| M-02 | §4/§1 | `claude-tmux.service` (`tmux -D`, own cgroup, `KillMode=control-group`) + `claude-web-term.service` `Requires=`/`After=` it + `needrestart` exemption `needrestart-claude.conf`. Consequence: restarting ttyd/`claude-web-term` is safe for sessions only because of this unit; the term-page deploy is `make-term-index.sh` + `systemctl restart claude-web-term` | infra/os/claude-tmux.service.template:7,41; webconsole/claude-web-term.service.template:54-61; os/needrestart-claude.conf:1; docs/architecture.md:173-186; os/SETUP.md §1b; tasks/lessons.md:248 | map's §4 never mentions it (rg `claude-tmux`, `KillMode`, `needrestart` = 0 hits). Any rebuild/rollback plan for /term restarts ttyd |
| M-03 | §1/§4 install | Deploy/install facts absent: `install.sh --infra` only prints commands and renders to `rendered/` (stages, installs nothing) (install.sh:303-304); it prints `install -m644` for `web-term.sh` (:362) though ttyd execs that path directly (claude-web-term.service.template ExecStart); `webterm-settle.sh` is called by tmux hooks at `/opt/claude-dashboard/webterm-settle.sh` but no install.sh line or SETUP.md step installs it; `themes.json`, `mdv`, `make-term-index.sh` output are separate manual steps; `claude-dash-lite` needs a restart on EVERY deploy (app/ walked once) | install.sh:303-395; os/tmux.conf:42-43; infra/SETUP.md:258-300 ("redeploy all three together: lite.mjs, web-term.sh, blocks") | a rebuild's deploy path must carry these; the map has the app/ copy list (§1.6) but not the three-file coupling or the missing settle install |
| M-04 | §1 | `mdv` helper (`infra/dashboard/mdv.template`) prints `/md?f=<urlencoded realpath>`; the /term web-links addon makes it tappable — the intended entry to `/md` from a session | infra/dashboard/mdv.template:1-11; infra/SETUP.md:220-230 | only producer of `/md` URLs besides in-page links; `/md` URL shape and clickable-in-xterm behaviour must survive the xterm.js 6 swap (D-U4) |
| M-05 | §6 tooling | README screenshot pipeline: `docs/assets/stage-demo.sh` (fake `/home` tree via `sed` of the literals `'/home'` and `` `/home/ `` in lite.mjs; shimmed `runuser`, `tmux` (9-field `list-panes -a -F` + `capture-pane`), `ps -eo` (stopped child => paused), `claude --version`, `claude-quota --line`, `ccusage daily/monthly/session/blocks` JSON), `demo-session.sh` (fake pty session behind a throwaway ttyd using the generated term-index.html), `mac-frame.html`; 8 PNG + 2 GIF + `fleet.tape` | docs/assets/stage-demo.sh:18-23,62-136,141-147,155-165; demo-session.sh:1-8; mac-frame.html:1-7; README.md:63-122 | a script touching the UI that the map's §6 omits (rg `stage-demo`, `docs/assets`, `demo-session` = 0). It breaks if lite.mjs changes those `/home` literals, the tmux field format, or the ccusage/claude-quota call shapes; it is also the only source of the README's "What it looks like" images |
| M-06 | §6/§7 baseline | `docs/qa/journeys/mobile-facelift.md` (7 steps) + `docs/qa/probes/mobile-facelift.mjs` (7 `check()`s: h1 starts "mows"; `.tabs` fixed, left>=10/right<=380, backdrop-filter, 5 `.tb`, scrollWidth<=390; `.fleet-cards .lp` radius 22px + `data-state` + title>=16px; `/system` `.mbar-row` 2 columns + `b.mbar-pct`; `/md` has `a[download]`/`raw=1` + 200; desktop `.tabs` not fixed + h1<26px; zero console errors except `interactive-widget`) + `baseline/2026-10-11-mobile-facelift/` (home-390, system-390, md-390, home-1280 PNG + `results-{chromium,webkit}.json`, 7 results each, all `ok`). Map §6.1 lists only agent-chat.md/agents-tab.md journeys; D-U3 names the baseline dir but nothing inventories what it holds or what it does NOT cover | docs/qa/probes/mobile-facelift.mjs:1-52; docs/qa/journeys/mobile-facelift.md:1-40; docs/qa/baseline/2026-10-11-mobile-facelift/ (6 files); MAP.md:21-22 | D-U3's "visual parity" baseline covers only `/`, `/system`, `/md` at 390 and `/` at 1280. There is NO baseline image for `/history`, `/s/*`, `/device`, `/agents*`, `/ui/*`, or `/term`; the map never says so |
| M-07 | §3 /ui | The /ui view DOM tree and UI copy are not mapped (map defers them to an "SPA mapper" at MAP.md:433, :493, but §3 has no such table). Missing: `AgentsList` card `a.agent.card` > `b` + `Pill` + `span.muted "<rel>|never ran · N runs · 7d $x"`; empty/loading strings "Loading…", "No agents yet.", "No such agent.", "No such run.", "Never run.", "No memory yet.", "Cleared by the agent.", "none"; `AgentDetail` = `.agwrap > a.agback + .ag2 > section.agchat(header.agh: a.agback-in, span.agav, .agti h1+`.agdot[title=running]`+p.agsub "<model> · $x spent", form.agctl[POST /a/agent-run]>button.cbtn[title "Run now"]) + aside.agside` with 5 cards (`h2.cl`): "Agent Telemetry" (`.tgrid .trow .tk .tv`, rows Profile/Soul/Target/Trigger/Budget/Daily Cap, a row renders nothing when null), "Capabilities" (`.cchips .cchip` or `p.capsum-in` "Inherits every tool — its file lists none."; `AUTHORITY_LINE` 5 sentences + fallback "Holds <kind> authority."; `details.capmore` "Full capability report"), "Recent Runs" (`ul.rruns li`: Pill + link + `.rcost`; `runLabel` = `HH:MM-PID`, prefixed `MM-DD ` when not today), "Memory" (`pre.mem`), `details.card.agev` "Events" (`pre.events`); `RunView` = `h1 a "← <name>" + "· <run>"`, `Pill`, "$x · N turns", `.m.claude > .mh > b + pre`; `ui.mjs` `rel()` (`Ns/Nm/Nh/Nd ago`), `usd()` (`$` + toFixed(2), non-numbers => $0.00), `Pill` class `pill st-<state|never>` | app/views/agents.mjs:7-30 (list), 36-37 (Row), 45-52 (runLabel), 54-71 (Telemetry), 76-95 (CapSummary), 97-181 (detail), 110-111, 163, 171-173; views/runs.mjs:5-15; ui.mjs:4-13 | classes `agctl agev agsub agti capmore capsum-in capsum-warn cbtn cchips rcost tk trow tv` have 0 hits in the map; a rebuild of /ui (the one app the spec rebuilds) needs the markup + strings the probes/journeys and CSS (lite.mjs:1935-2105) key off |
| M-08 | §3 /ui | `CapabilityPanel` render rules (map admits "per-field rendering rules not recorded", MAP.md:631): h2 "What this agent can do"; null => `p.cap-warn` "Unknown." paragraph; `ul.auth` one `li` per authority from `AUTHORITY_TEXT` (5 kinds, 2 sentences each, tools in `span.muted`); `permissionMode: plan` caveat; `p.cap-unknown` for `mcpTools` and `unclassifiedTools`; inherit paragraph naming "27 tools, of which this page classifies 8"; the single `quiet` condition (7 flags) for the reassuring sentence; `ul.policy` 5 `li`s (profile, workdir, permissionMode, budget with `money()`/`count()` "an unknown amount/number of", webhook/trigger counts); `webhookArmed`/`webhookDeclaredInert`/`turnCapDisagreement` paragraphs; closing "What this page cannot see". Every value is a preact text child (no innerHTML) and `htm` newline trimming needs explicit `${' '}` | app/views/capability.mjs:30-34, 53-58, 76-79, 81-165 | preflight 5d / G-16 walk this tree (170 PASS); copy and structure are asserted by `scripts/capability-check.mjs` and 104 mutations in capability-coverage.mjs. Classes `cap-warn cap-unknown` have 0 hits in the map |
| M-09 | §3 /ui chat | Chat markup/behaviours not recorded: `p.chint` "<name> has access to <tools>.<span.chint-help> Use /help for commands.</span>" (only when explicit tool list); `button.sendb` (disabled while busy, `aria-label` Sending/Send, shows "…" only when busy, icon is `--ico-send` mask); message = `.m.me|.claude > span.mav[aria-hidden] + .mc > .mh(b "you"|<agent>, span.muted time) + .mb`; `.sysdiv > span.sysl, span.sysb > i.sysi + text + muted time, span.sysl`; header time = ISO `slice(11,19)` (the server's clock, not local); "Thinking…" shown when busy and no live text; textarea `rows=2 required`, placeholder switches at `(max-width:500px)` between "Ask <name>…" and "Ask <name> to analyze or run commands…"; `p.cherr[role=alert]` | app/views/chat.mjs:249-253, 449-467, 468-484 | classes `chint chint-help mav sendb sysdiv sysi` have 0 hits; probes depend on `.cherr .chatf button .m.me` (MAP.md:888) but the rest of the tree is unspecified |
| M-10 | §1/§6 docs | Existing design docs and lessons are never referenced by the map: `docs/superpowers/specs/2026-09-16-dashboard-spa-design.md` (§2 "Kept" list, §6 migration "twins retired one at a time after a week on the box", ADDENDUM of what was NOT built), `2026-08-28-fleet-redesign-design.md`, `2026-08-25-persistent-terminal-shell-design.md` (describes a `/?embed=1` mode, §3 :115 — lite.mjs has no `embed` handling: grep hits are comments only), `2026-09-17-agents-figma-redesign-design.md` (geometry, icon inventory, definition of done), and `tasks/lessons.md` (28 KB of incident-derived UI invariants, e.g. pane_id not `=name`, SSE `aborted` vs `close`, hand-patches wiped by regen, resize-window unset load-bearing) | docs/superpowers/specs/*.md; tasks/lessons.md:46,91,143,325; docs/architecture.md:256-262 | rg `lessons.md|dashboard-spa-design|fleet-redesign|persistent-terminal-shell|agents-figma` = 0 hits; the SPA code comments cite "spec §2/§3/D4/D7" and those specs are the authority |
| M-11 | §1 infra | Caddy access log sink and oauth2-proxy session config: primary vhost logs to `/var/log/caddy/console.json` (`roll_size 20mb`, `roll_keep 3`); per-profile and droid vhosts use bare `log`; this is where `/z?…` beacons and `/term/__shim?…` pings land. oauth2-proxy: `cookie_expire = "168h"`, `cookie_domains = [".{{DOMAIN}}"]`, `whitelist_domains`, `skip_provider_button = true`, `authenticated_emails_file`, `upstreams=["static://202"]`, `set_xauthrequest = true` | Caddyfile.template:113-117,162,182; oauth2-proxy/oauth2-proxy.cfg.template:37-47 | map says "via Caddy gauth / :4180" only (no cookie lifetime/scope); the 7-day cookie and shared apex-domain cookie govern PWA re-login and every fetch/SSE the new client makes |
| M-12 | §1 | Two generators/consumers of the web surface outside infra/: `fleet/add-agent.sh --vhost` emits a per-agent Caddy block importing only `pwa`, `gauth`, `vncproxy` (no `webhook`, `droidproxy`, `sse`, no `@nosse` encode exclusion), differing from Caddyfile.template:161-174; `claude/skills/stack-health/check.py` probes `3005` (200), `7681/term/` (200), `4180`, units `claude-dash-lite claude-web-term` | fleet/add-agent.sh:316-327; claude/skills/stack-health/check.py:61-66,201-210 | per-agent hosts get `/events` without flush/encode exclusion; any port or unit rename breaks stack-health; map's `HOST_ACCT` rows assume the template shape |
| M-13 | §2/§3/§4 a11y | Accessibility attributes are not inventoried: lite.mjs has 19 `aria-label` (e.g. "filter fleet sessions", "Filter by project path or session id", "session name", "open terminal", "toggle full screen", 8 remote-key labels), 39 `aria-hidden`, `aria-disabled`, 20 `title=`; /ui views add `aria-label` Back to agents/Send/Sending, `role=alert`; blocks add `aria-label=sessions` (cchome), `enterkeyhint/autocorrect/spellcheck` (ccime) | lite.mjs:816-823, 892, 2440, 3042, 3075, 3102, 3140, 3169, 3230; chat.mjs:467,482; agents.mjs:123; 30-cchome.html:3 | map hits: `aria-label` 2, `aria-hidden` 0, `role=` 0; none of the label strings appear; a11y parity is not specifiable from the map |
| M-14 | §1.1 doc conflict | `infra/SETUP.md` says `POST /settings/term-theme` takes form field `theme=<name>`; code accepts only JSON `{name}` (400 `invalid json` otherwise); `README.md:109-110` points readers at the same endpoint. Map records the code shape but not the contradiction | infra/SETUP.md:334; lite.mjs:762-784 | doc drift a rebuild must not "restore" by accident; also the persistent-shell spec's `/?embed=1` (M-10) |

### 8.2 Present but thinner than the code
| map ref | what the map says | what the code also has | file:line |
|---|---|---|---|
| §4.5 MAP.md:725 | tmux side: prefix C-q, mouse, set-titles, 2 hooks | `bind -n M-Left/Right/Up/Down` pane select; `history-limit 50000` (scrollback the key bar's PgUp/PgDn wheel events reach); `session-created` hook re-applies `@label` via `ccname --restore` from `~/.local/state/cc-labels/` | os/tmux.conf:5-9,16,38-41 |
| §4.2 B-75 / MAP.md:716 | colours one-liner (`#161b22 #21262d …`) | `#8b949e`, `#c9d1d9` also used; geometry: `#cckb` z50, h46, key min-w44 h36; sheet z70, backdrop rgba(0,0,0,.55), `.pan` radius 16 max-h 70%, rows min-h 52 / font 15, pill max-w 38vw, theme select max-w 132; sheet motion `transition: display .25s allow-discrete` + `@starting-style` (rg `allow-discrete|starting-style` = 0) | blocks/75-ccsess.html:21-45; 10-cckb.html:2,5; 46-cctheme.html:2 |
| §5 V-04 / MAP.md:5.6 ("patch not read line by line") | 6 files patched, purposes per SETUP.md | iOS `force` clamp (36.3 off-spec -> overflow throws -> gesture dead); `buttons:0` on touchend/touchcancel; `fitToScreen` URL param; toolbar side-vs-bottom size math + 24px; localStorage key now `${prefix}:v2:<udid>:<WxH>`; server bind forced `127.0.0.1`; app.css `@media(max-width:700px)` bottom toolbar, `touch-action:none/manipulation`, `float:none` | infra/droid/ws-scrcpy.patch:9-11,23-32,40-48,60-79,91-98,110-112,124-162 |
| §1.6 / §2.5 `hostAcct`, accounts | colours "not enumerated" | `PALETTE` = 8 hex values cycled by account index; agent accounts (`agent`, `agent-<n>`) sort after humans and never get `term` affordances; only profile dirs with `projects/` count | lite.mjs:70, 78-108, 119 |
| §6.1 G-23 | "85 `chk` lines" | 84 invocations + the `chk(){}` definition at :9; 2 inside a 4-iteration loop => 90 executed (matches the "90 passed" comment) | scripts/e2e-infra.sh:9,207-210 |
| §1.1 "dispatcher top-level branches = 42" | S-01..S-42 | 41 distinct dispatcher branches (39 `if`/match + 404 + 500); S-11 and S-12 are ONE `startsWith('/agents/')` branch split on `/` | lite.mjs:3922-3925 |
| §3.2 R-01..R-03 | regex router | `App` re-renders on a `route` window event; link capture selector `a[href^="/ui"]`; `popstate` TODO that outgoing scroll is never saved (map has it); `RunView`/`AgentDetail` blank data with `setD(null)` on param change (so Chat unmounts, pendings reset) | app/main.mjs:15-19,31-45; agents.mjs:99; chat.mjs:290 |
| §2.4 /fleet.js, SW | covered | SW `OFF` page text and `Response` headers covered; not covered: SW has no `/ui` registration (map notes "not verified in app/main.mjs"): confirmed, `uiShellHtml` and app/ never call `serviceWorker.register` | lite.mjs:2456 (only registration), 3856-3868; app/*.mjs |
| §4.2 B-30 | beacon `t=term-v8` | same beacon also sends `lvh/dvh/svh/kbb`; base page beacon is `t=dash3` (map has) and `t=vpfix&ok=0|1&r=1&n&ih&p` | 30-cchome.html:11-28; lite.mjs:2492,2515,2523 |
| §4.7 mobile-journey | "claims 114 assertions" | contexts use `reducedMotion:'reduce'` plus one motion scenario for the session sheet; documented as "cannot see iOS keyboard / real env() insets / scroll feel => say 'needs a device check'" | infra/SETUP.md:308-321 |

### 8.3 Inventory counts (V2 vs sections 1–7)
| thing | V2 counted | map says |
|---|---|---|
| dispatcher branches (incl. 404 + 500) | 41 | 42 (S-01..S-42; S-11/S-12 are one branch) |
| POST-accepting actions | 20 (del, restartall, switch, kill, pause, resume, label, agent-chat/run/pause/resume/stop, droid start/stop, watch start/stop, term-theme, reclaim, /shot, /wh) | 20 |
| SSE endpoints | 2 (`text/event-stream` at 2751, 2831) | 2 |
| `<form` emit sites in lite.mjs | 16 lines (725,726,797,798,1144,1251,1346,1348,3042,3073-3076,3229,3529,3545) | all present as S-rows |
| `@media` statements / distinct conditions | 24 / 11 | 24 / 11 |
| `@keyframes` | 7 | 7 |
| `:root` custom props | 28 + 3 icon masks + `--tbo` = 32 (+ runtime `--kb`) | 32 |
| ICO glyphs | 31 | 31 |
| `<template>` | 2 (fleet row/card) | 2 |
| `class=` names emitted by lite.mjs (static) | 157 | 156 present; `language-<info>` is a marked-style template literal, not a class |
| static class tokens emitted by app/views/*.mjs + ui.mjs | 56 distinct | 21 absent from the map (agctl agev agsub agti capmore capsum-in capsum-warn cbtn cchips rcost tk trow tv cap-unknown cap-warn chint chint-help mav sendb sysdiv sysi; see M-07..M-09) |
| terminal blocks | 12 + clipboard shim | 12 + shim |
| `?x=off` kill switches | 6 (`u11 ime clip rst paint theme`) + `?theme=<Name>` setter + `?paintdbg=1` | 6 |
| localStorage / sessionStorage keys (first-party) | `ccfontsize`, `cctheme` / `ccpaint-r`, `vpr` (+ ws-scrcpy `…:v2:…` via patch) | first four present; ws-scrcpy key absent |
| `window.*` globals from blocks | `cctheme`, `__ccimeWS`, `__ccimeKick`, `__ccime`, + 3 `window.WebSocket` wraps | present |
| fetch / sendBeacon / EventSource sites | lite inline 4 fetch (+SW 1) + 1 EventSource; blocks 6 fetch + 1 sendBeacon; app 2 fetch + 1 EventSource | present |
| `web-term.sh` modes (`case` arms) | 8: run list attach menu resume resolve open switch | 8 |
| Caddy: snippets / site blocks / `handle` | 6 snippets (gauth vncproxy droidproxy webhook pwa sse) / 3 sites (apex, `<sub>.`, `droid.`) / 9 `handle`+`handle_response` | snippets and sites present; no count stated |
| systemd units/templates in repo | 11 (remote@, remote-control@, prune .service+.timer, claude-tmux, qa-watch, ws-scrcpy, web-term, dash-lite, oauth2-proxy, docker-user-fence) + `clipboard.conf` drop-in | 5 described (dash-lite, web-term, clipboard.conf, qa-watch, ws-scrcpy) |
| scripts/gates touching the UI | 31 G-rows' worth + mobile-facelift journey/probe + stage-demo trio + stack-health check.py + fleet/add-agent.sh vhost | 31 G-rows |
| `docs/qa/journeys/*.md` | 3 (agent-chat, agents-tab, mobile-facelift) | 2 |
| `e2e-infra.sh` chk call sites | 84 (+1 def) | 85 |

### 8.4 Not walked by V2
- Did not read `chat.mjs` lines 1-243 and 300-380 line by line (markdown override/tokenizer, reconcile); only the render tail, EV_RE/feed, and class/aria surface.
- Did not read `scripts/*-check.mjs` bodies, `docs/qa/probes/probes.mjs`, `mobile-journey.mjs` beyond counts/headers; did not run any gate.
- Did not read `agents/bin/mows-agent` / `mows-agent-meta` bodies (only their coupling comments to lite.mjs) nor `capability.mjs` server module.
- Did not read `infra/droid/SETUP.md`, `infra/qa-watch/SETUP.md`, `infra/os/SETUP.md` §2+ (firewall, fail2ban, sshd), `fleet/`, `watchdogs/`, `agy/`.
- Did not read the five `docs/superpowers/specs/*.md` or `plans/*.md` bodies beyond headings; M-10's claims rest on headings and two greps (`embed`, `lessons.md`).
- Did not verify any live-box state (deployed unit modes, drop-ins, whether `webterm-settle.sh` exists under `/opt/claude-dashboard`); M-03 is repo-only.
- Did not diff the map's line citations (that is V1a/V1b's job); the line numbers in my rows are from the branch file as it stands (lite.mjs 4101 lines).
- Did not exhaustively check `lite.mjs` CSS rule bodies against the map (only selectors/classes, vars, media, keyframes).
