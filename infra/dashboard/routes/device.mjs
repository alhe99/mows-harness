import { execFile } from 'node:child_process';
import net from 'node:net';
import { readBody, sameOrigin, sh } from '../core.mjs';


// ---------- QA watch: noVNC view of the shared headless browser ----------
// watch-browser.sh runs Xvfb :99 + x11vnc + websockify(6080) + a real Chrome
// (CDP 9222) — normally localhost-only. Caddy now proxies /vnc/* -> 6080 behind
// the same Google login, so this page embeds it: you see what the agent drives
// and can click/type to take over (do an OTP login, or eyeball a UI change).
let watchCache = { t: 0, up: false };

function probe(port) {
  return new Promise(r => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 }, () => { s.destroy(); r(true); });
    const no = () => { s.destroy(); r(false); };
    s.on('error', no); s.on('timeout', no);
  });
}

export async function watchLive() {
  if (Date.now() - watchCache.t < 3000) return watchCache.up;
  watchCache = { t: Date.now(), up: await probe(6080) };
  return watchCache.up;
}

export async function watchAction(req, res, p) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  await readBody(req); // drain
  // The stack is its OWN systemd unit, NOT a child of this service — so redeploying
  // or OOM-restarting the dashboard never kills a live take-over browser. start is
  // idempotent (skip if already up); stop tears the whole cgroup down (frees ~0.5G).
  const ctl = v => new Promise(r => execFile('systemctl', [v, 'claude-qa-watch.service'], { timeout: 20000 }, () => r()));
  if (p === '/watch/start') { if (!(await probe(6080))) await ctl('start'); }
  else await ctl('stop');
  watchCache.t = 0;
  res.writeHead(303, { location: '/device?dv=web' }); res.end();
}

// ---------- /droid: Android emulator (redroid container + ws-scrcpy console) ----------
// Optional stack — see infra/droid/SETUP.md. With it absent this page still renders,
// reporting the emulator stopped (docker inspect on a missing container just fails).
export const DROID_UDID = '127.0.0.1:6555';

export async function droidState() {
  const run = (await sh('docker', ['inspect', '-f', '{{.State.Running}}', 'redroid'])).trim() === 'true';
  if (!run) return { state: 'stopped', res: '' };
  const boot = (await sh('adb', ['-s', DROID_UDID, 'shell', 'getprop', 'sys.boot_completed'])).trim();
  if (boot !== '1') return { state: 'booting', res: '' };
  const wm = (await sh('adb', ['-s', DROID_UDID, 'shell', 'wm', 'size'])).trim(); // "Physical size: 1080x1920"
  const m = /(\d+)x(\d+)/.exec(wm);
  return { state: 'live', res: m ? `${m[1]}×${m[2]}` : '' };
}

export async function droidAction(req, res, p) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  await readBody(req); // drain
  const run = (cmd, args, t) => new Promise(r => execFile(cmd, args, { timeout: t }, () => r()));
  if (p === '/droid/start') {
    await run('docker', ['start', 'redroid'], 20000);
    await run('adb', ['connect', DROID_UDID], 5000); // put the device on the adb server so ws-scrcpy's tracker sees it
  } else {
    await run('adb', ['disconnect', DROID_UDID], 5000);
    await run('docker', ['stop', 'redroid'], 30000);
  }
  res.writeHead(303, { location: '/device?dv=mobile' }); res.end();
}
