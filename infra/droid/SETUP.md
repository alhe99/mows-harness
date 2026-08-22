# droid — containerized Android in the browser (optional)

Container-based Android (redroid: no KVM, native-arch execution, ~700 MB RAM idle, boots
in ~15 s) plus ws-scrcpy, so a real Android device is one tab away for mobile QA: watch
and touch-control it from the dashboard's `/droid` page, install APKs over adb from
`/term`, drive flows with maestro. Everything binds loopback; the only public paths are
Caddy's Google-gated routes (`/droidview/*` + the optional `droid.{{DOMAIN}}` vhost —
both already in `infra/caddy/Caddyfile.template`).

This layer is optional. Skip it entirely and nothing else in the harness cares: the
Caddyfile's droid routes just never get hit, and the dashboard's `/droid` page reports
the emulator stopped.

Prerequisites: Docker (`sudo apt-get install -y docker.io`), Node (see
[`infra/SETUP.md`](../SETUP.md)), plus `sudo apt-get install -y adb`.

## 1. binder kernel modules (once, persisted)

redroid needs Android's binder IPC in the host kernel:

```bash
echo binder_linux | sudo tee /etc/modules-load.d/binder.conf
echo 'options binder_linux devices=binder,hwbinder,vndbinder' | sudo tee /etc/modprobe.d/binder.conf
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder
```

## 2. the container

```bash
mkdir -p ~/redroid/data
docker run -itd --privileged --name redroid \
  -v ~/redroid/data:/data \
  -p 127.0.0.1:6555:5555 \
  redroid/redroid:15.0.0-latest \
  androidboot.redroid_gpu_mode=guest \
  androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_dpi=320
adb connect 127.0.0.1:6555
```

The choices, and why:

- **Host port 6555, loopback-only** — outside adb's emulator scan range (5555+) so the
  device appears exactly once in `adb devices`, and never exposed publicly.
- **720x1280 (16:9), not a tall modern aspect** — a phone browser viewport is ~0.63 w/h,
  so a 19.5:9 stream becomes height-limited and wastes *width* (measured: 16:9 fills ~82%
  of a phone screen, 19.5:9 only ~67%). Bump `redroid_height` only if an app genuinely
  needs a taller aspect.
- **`gpu_mode=guest`** (software rendering) — assume no GPU on a VPS.
- **Android 15** — verified working (boot + stream + touch). **Android 16 does not boot**
  on a GPU-less host (surfaceflinger crash-loops in RenderEngine; verified 2026-08-11) —
  retry only after redroid ships a fix. Other tags (8.1–16) exist on Docker Hub; Android's
  `/data` never survives version jumps, so wipe `~/redroid/data` when switching.
- **No Google Play services** (AOSP image): fine for your own APKs; FCM tokens and Google
  Maps won't work. `-gapps` image tags exist if you need them (new container + `/data` wipe).
- **On-demand, not auto-started** (`--restart` deliberately absent) — ~700 MB idle is real
  RAM on a small VPS. `install -m755 infra/droid/up.sh ~/redroid/up.sh`; daily use is
  `~/redroid/up.sh` to start (prints when booted) and `docker stop redroid` when done. The
  dashboard's `/droid` page has start/stop buttons doing the same thing.

## 3. ws-scrcpy (the web console), patched

```bash
git clone https://github.com/NetrisTV/ws-scrcpy ~/redroid/ws-scrcpy
cd ~/redroid/ws-scrcpy
git apply /path/to/mows-harness/infra/droid/ws-scrcpy.patch
npm ci && npm run dist
cd dist && npm install   # dist has its own runtime package.json
```

`ws-scrcpy.patch` is small and this harness's own; what it changes and why it exists:

- **`HttpServer.ts`: bind 127.0.0.1** — upstream listens on all interfaces; here Caddy is
  the only public surface.
- **`InteractionHandler.ts` + `TouchControlMessage.ts`: the iOS touch fix** — iOS Safari
  reports `touch.force` off-spec (~36 on touchstart, 0 on move/end; spec says 0..1).
  Upstream passes it straight into `writeUInt16BE(pressure * 0xffff)`, which overflows and
  **throws**, so the touch-DOWN message is never sent and every tap on an iPhone is
  ignored — while desktop mouse, Chromium touch emulation, and Playwright WebKit all look
  fine. Patch: clamp off-spec/zero force to full pressure at the handler, and harden
  `toBuffer` so out-of-range pressure can never throw again.
- **`app.css` + `BasePlayer.ts`: phone layout** — on ≤700px screens the control toolbar
  moves from a right-hand column (which stole width, the limiting dimension on a phone) to
  a bottom bar, and `getMaxSize` subtracts it from the axis it actually occupies.
- **`StreamClientScrcpy.ts`** — supporting changes for the above.

Then install the systemd unit (rendered by `install.sh --infra`, or by hand from
`ws-scrcpy.service.template` — see that file's header):

```bash
sudo install -m644 rendered/ws-scrcpy.service /etc/systemd/system/ws-scrcpy.service
sudo systemctl daemon-reload && sudo systemctl enable --now ws-scrcpy
```

Unlike the container, the console **is** enabled at boot — it's a ~50 MB node process,
and it's how you see that the container is up. Ops: `sudo systemctl {status,restart}
ws-scrcpy`, logs via `journalctl -u ws-scrcpy`.

## 4. use it

- **Dashboard `/droid` page** (ships in `infra/dashboard/lite.mjs`): start/stop buttons,
  live stream, touch/type in the frame. Phones get the stream full-page instead of an
  iframe — iOS ignores an iframe's `<meta viewport>` and lays the inner document out at a
  phantom 980px width, so in-frame taps never line up. There's an on-device touch
  diagnostic at `/droid/touchtest` if input ever misbehaves.
- **Raw console** (`droid.{{DOMAIN}}`, or the `⧉ console` chip on `/droid`): device list →
  pick a player (WebCodecs best in desktop Chrome; Broadway/TinyH264 work anywhere), plus
  web adb shell, devtools for webviews, and a file browser. Keep the default "proxy over
  adb" interface — it streams through :8000, so the Caddy/gauth path carries it.
- **APKs + flows** from `/term`:

```bash
adb -s 127.0.0.1:6555 install app.apk
maestro --device 127.0.0.1:6555 test flow.yaml
```

- **QA journeys** (`claude/skills/qa`): a mobile step in a `docs/qa/journeys/*.md` is just
  a shell-out — ensure device (`~/redroid/up.sh`), `adb install -r`, `maestro test`,
  screenshot into the report. For a watched journey's human step on Android, the `/droid`
  page is the mobile equivalent of the noVNC pause: do the step in the browser, then
  continue.
