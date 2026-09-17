// Browser probes for the dashboard SPA — the scripted form of docs/qa/journeys/agent-chat.md.
//
//   node docs/qa/probes/probes.mjs <journey|lost|repeat|csp|base> <chromium|webkit>
//
// Normally started by run.sh, which stands up the fixture dashboard and the proxy first. See
// README.md in this directory for what these are, what they cannot tell you, and why preflight
// does not call them.
//
// IT SKIPS, LOUDLY, WITHOUT PLAYWRIGHT. Playwright is not a dependency of this repo and must not
// become one: the no-dependency rule is about what the dashboard ships and runs. Same shape as the
// HTTP/2 assertion in scripts/e2e-infra.sh, which SKIPs without MOWS_HOST — and for the same
// reason, the skip prints exactly what is missing and how to supply it. A skip that says nothing
// is just a green line.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODE = process.argv[2] || 'journey';
const ENGINE = process.argv[3] || 'chromium';
const DIRECT = process.env.MOWS_QA_DIRECT || 'http://127.0.0.1:3105';   // the dashboard itself
const BASE = process.env.MOWS_QA_BASE || 'http://127.0.0.1:3205';       // ...through the cuttable proxy
const CUT = process.env.MOWS_QA_CUT || 'http://127.0.0.1:3206';
const BOX = process.env.MOWS_QA_CONTAINER || 'mows-qa-ui';
const AGENT = 'harness-reviewer';

// ---- finding Playwright, without naming anyone's home directory in a tracked file --------------
async function loadPlaywright() {
  const tried = [];
  if (process.env.PLAYWRIGHT) {
    tried.push(process.env.PLAYWRIGHT);
    if (existsSync(process.env.PLAYWRIGHT)) return import(pathToFileURL(process.env.PLAYWRIGHT).href);
  }
  try { return await import('playwright'); } catch { tried.push('bare specifier "playwright"'); }
  // npx leaves installs under ~/.npm/_npx/<hash>/node_modules; if one is there, use it rather than
  // making the reader install a second copy.
  const npx = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const d of readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', 'playwright', 'index.mjs');
      if (existsSync(p)) return import(pathToFileURL(p).href);
    }
  } catch { /* no npx cache; not an error */ }
  tried.push(path.join('~', '.npm', '_npx', '*', 'node_modules', 'playwright'));
  return { __missing: tried };
}

const pw = await loadPlaywright();
if (pw.__missing) {
  console.log(`SKIP: [${ENGINE}] ${MODE} — Playwright is not installed, and it is deliberately not a`);
  console.log('      dependency of this repo. Install it once, OUTSIDE the repo, then re-run:');
  console.log('');
  console.log('        mkdir -p ~/.cache/mows-qa && cd ~/.cache/mows-qa');
  console.log('        npm i playwright && npx playwright install chromium webkit');
  console.log('        export PLAYWRIGHT=~/.cache/mows-qa/node_modules/playwright/index.mjs');
  console.log('');
  console.log('      looked in: ' + pw.__missing.join(', '));
  console.log(`RESULT[${ENGINE}/${MODE}]: SKIPPED — nothing was measured`);
  process.exit(0);
}
if (!pw[ENGINE]) {
  console.log(`SKIP: [${ENGINE}] ${MODE} — this Playwright has no "${ENGINE}" launcher`);
  console.log(`RESULT[${ENGINE}/${MODE}]: SKIPPED — nothing was measured`);
  process.exit(0);
}

// ---- the small amount of shared machinery -----------------------------------------------------
let failed = 0;
const notes = [];
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + `: [${ENGINE}] ` + name);
  if (!cond) { failed = 1; if (detail !== undefined) console.log('   got: ' + JSON.stringify(detail)); }
};
const note = s => { notes.push(s); console.log(`NOTE: [${ENGINE}] ` + s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Injection goes STRAIGHT to the dashboard, never through the proxy: the cut below takes the proxy
// down, and an injector that goes dark with the page under test proves nothing.
const inject = async (turn, seq, delta) => {
  const r = await fetch(`${DIRECT}/_test/chat?agent=${AGENT}&turn=${turn}&seq=${seq}&delta=${encodeURIComponent(delta)}`);
  if (r.status !== 204) throw new Error('inject failed: ' + r.status);
};
const endTurn = async turn => {
  const r = await fetch(`${DIRECT}/_test/chatend?agent=${AGENT}&turn=${turn}&cost_usd=0.02`);
  if (r.status !== 204) throw new Error('end failed: ' + r.status);
};
const inBox = cmd => execFileSync('docker', ['exec', BOX, 'bash', '-c', cmd]);
// Built, not written out: preflight forbids a bare home path in a tracked file, and
// docs/qa/probes/fixture.sh builds the same path the same way for the same reason.
const DEMO_HOME = ['', 'home', 'demo'].join('/');
const TRANSCRIPT = `${DEMO_HOME}/.local/state/mows-agents/${AGENT}/chat.jsonl`;
// What mows-agent's cmd_chat does before printing its end line. Without it the reload assertions
// would be measuring the salvage path rather than the saved transcript.
const saveTurn = text => inBox(`printf '%s\\n' ${JSON.stringify(JSON.stringify(
  { at: new Date().toISOString(), role: 'assistant', text, cost_usd: 0.02 }))} >> ${TRANSCRIPT}`);

// The STREAMING bubble specifically, not "the last bubble" — the saved transcript's last assistant
// turn is also .m.claude and would answer for it.
const liveText = p => p.evaluate(() => document.querySelector('.chatbox .m.claude.streaming .mb')?.innerText ?? null);
const boxMetrics = p => p.evaluate(() => {
  const el = document.querySelector('.chatbox');
  return el ? { top: Math.round(el.scrollTop), h: el.scrollHeight, c: el.clientHeight } : null;
});
// A send driven the way a person drives it: set the value through the native setter (so a
// controlled input would notice), then submit the form.
const sendMessage = (page, text, settleMs = 2500) => page.evaluate(async ([t, ms]) => {
  const ta = document.querySelector('.chat .chatf textarea');
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, t);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.chat .chatf').requestSubmit();
  await new Promise(r => setTimeout(r, ms));
  return {
    users: [...document.querySelectorAll('.chatbox .m.me')].map(e => e.innerText.replace(/\s+/g, ' ').trim()),
    err: document.querySelector('.cherr')?.textContent || null,
    composer: document.querySelector('.chat .chatf textarea').value,
    busy: document.querySelector('.chat .chatf button').disabled,
  };
}, [text, settleMs]);

const browser = await pw[ENGINE].launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

try {
  if (MODE === 'journey') await journey();
  else if (MODE === 'lost') await lost();
  else if (MODE === 'repeat') await repeat();
  else if (MODE === 'csp') await csp();
  else if (MODE === 'base') await baselinePages();
  else { console.log('unknown mode: ' + MODE); failed = 1; }
} catch (e) {
  failed = 1;
  console.log(`FAIL: [${ENGINE}] ${MODE} threw: ` + (e && e.stack || e));
  console.log('   console: ' + JSON.stringify(consoleErrors.slice(0, 5)));
} finally {
  await browser.close();
}
console.log(`RESULT[${ENGINE}/${MODE}]: ` + (failed ? 'FAILURES' : 'all green') + (notes.length ? ` (${notes.length} note(s))` : ''));
process.exit(failed);

// ---- journey steps 1-9 -------------------------------------------------------------------------
async function journey() {
  // 1. The SPA boots at all. Load-bearing for WebKit specifically: the shell has no bundler and
  // leans on an inline <script type="importmap"> plus bare specifiers, which Safari shipped in 16.4.
  await page.goto(`${BASE}/ui/agents`, { waitUntil: 'load' });
  await page.waitForSelector('a[href^="/ui/agents/"]', { timeout: 15000 });
  check('SPA boots: import map + bare specifiers resolve, agents list renders',
    (await page.locator('a[href^="/ui/agents/"]').count()) > 0);

  await page.click(`a[href="/ui/agents/${AGENT}"]`);
  await page.waitForSelector('.chatbox', { timeout: 15000 });
  check('agent detail renders a chat transcript and a composer',
    (await page.locator('.chat .chatf textarea').count()) === 1);

  // 2-5. The reply must grow INCREMENTALLY. A reply that lands in one block looks correct and is a
  // regression, which is why the journey samples rather than waiting for the end.
  const turn = Date.now();
  const samples = [];
  await inject(turn, 1, 'Looking at the last run: ');
  await page.waitForSelector('.m.claude.streaming', { timeout: 10000 });
  samples.push((await liveText(page))?.length ?? 0);
  await inject(turn, 2, 'it flagged two shell-quoting issues ');
  await sleep(400); samples.push((await liveText(page))?.length ?? 0);
  await inject(turn, 3, 'and one README drift.');
  await sleep(400); samples.push((await liveText(page))?.length ?? 0);
  check('the reply grows incrementally (three samples, increasing)',
    samples[0] > 0 && samples[1] > samples[0] && samples[2] > samples[1], samples);

  // 6-7. THE WEBKIT CLAIM. The view hand-rolls scroll anchoring because Safari implements no CSS
  // scroll-anchoring; until this probe existed that reasoning had only been exercised in Chromium.
  for (let i = 4; i < 44; i++) await inject(turn, i, `\n\nParagraph ${i} of the reply, long enough to overflow the transcript box and make it scrollable.`);
  await sleep(1200);
  const grown = await boxMetrics(page);
  check('the transcript box actually overflows (precondition for the scroll test)',
    grown && grown.h > grown.c + 100, grown);

  await page.evaluate(() => { document.querySelector('.chatbox').scrollTop = 0; });
  await page.dispatchEvent('.chatbox', 'scroll');
  await sleep(300);
  const up = await boxMetrics(page);
  await inject(turn, 100, '\n\nA token that arrives while the operator is reading back.');
  await sleep(700);
  const afterToken = await boxMetrics(page);
  check('scrolled up mid-stream, the view does NOT jump to the bottom on the next token',
    afterToken.top === up.top && afterToken.top < 40, { up, afterToken });
  check('a "Jump to latest" control appears while scrolled up',
    (await page.locator('button.jump').count()) === 1);

  await page.click('button.jump');
  await sleep(400);
  const jumped = await boxMetrics(page);
  check('"Jump to latest" returns the view to the bottom',
    jumped.h - jumped.top - jumped.c < 40, jumped);
  await inject(turn, 101, '\n\nAnd it follows new tokens again afterwards.');
  await sleep(700);
  const following = await boxMetrics(page);
  check('...and it follows new tokens again afterwards',
    following.h > jumped.h && following.h - following.top - following.c < 40, { jumped, following });

  // 8. The mobile layout. SIMULATED keyboard — see README for why that is not the real thing.
  await page.setViewportSize({ width: 375, height: 812 });
  await sleep(300);
  await page.focus('.chat .chatf textarea');
  await sleep(300);
  const narrow = await page.evaluate(() => ({
    docScrollW: document.scrollingElement.scrollWidth,
    innerW: window.innerWidth,
    kb: getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(),
    composerBottom: Math.round(document.querySelector('.chat .chatf').getBoundingClientRect().bottom),
    vvH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
  }));
  check('at 375x812 there is no horizontal page scroll', narrow.docScrollW <= narrow.innerW + 1, narrow);
  check('visualViewport exists in this engine, so the composer handler has an input at all',
    narrow.vvH !== null, narrow);
  check('the composer sits within the visual viewport with the composer focused',
    narrow.vvH !== null && narrow.composerBottom <= narrow.vvH + 1, narrow);
  await page.setViewportSize({ width: 900, height: 800 });

  // A SECOND VIEWER on the same agent, during the same turn.
  const page2 = await ctx.newPage();
  page2.on('pageerror', e => consoleErrors.push('page2 pageerror: ' + e.message));
  await page2.goto(`${BASE}/ui/agents/${AGENT}`, { waitUntil: 'load' });
  await page2.waitForSelector('.chatbox', { timeout: 15000 });
  await sleep(500);
  await inject(turn, 200, '\n\nA token sent while two tabs are watching.');
  await sleep(900);
  const t1 = await liveText(page), t2 = await liveText(page2);
  check('a second tab opened mid-turn receives subsequent tokens',
    !!t2 && t2.includes('two tabs are watching'), { t2: t2 && t2.slice(-80) });
  check('the first tab is unaffected by the second subscriber',
    !!t1 && t1.includes('two tabs are watching'), { t1: t1 && t1.slice(-80) });
  // The late tab holds a SUFFIX of the turn, which is the condition the `includes`-not-`===`
  // salvage rule in chat.mjs was written for. Measured here rather than reasoned about.
  check('the late tab holds only a suffix, not the whole turn (the salvage rule\'s premise)',
    t2.length < t1.length, { t1len: t1.length, t2len: t2.length });

  // MID-TURN SSE RECONNECT, from a real browser. See proxy.mjs for why this is a socket cut and
  // not ctx.setOffline().
  const cut = await (await fetch(CUT + '/')).text();
  note('cut the proxied sockets mid-turn: ' + cut.trim());
  await sleep(300);
  await inject(turn, 201, ' MISSEDWHILEOFFLINE');
  const whileDown = await liveText(page2);
  check('the delta injected while the stream was down did not reach the browser (the cut was real)',
    !whileDown || !whileDown.includes('MISSEDWHILEOFFLINE'), whileDown && whileDown.slice(-70));
  let reconnected = false, after2 = null;
  for (let i = 0; i < 60 && !reconnected; i++) {
    await sleep(500);
    after2 = await liveText(page2);
    reconnected = !!after2 && after2.includes('MISSEDWHILEOFFLINE');
  }
  check('a browser that lost its stream mid-turn recovers the deltas it missed', reconnected,
    { after: after2 && after2.slice(-70) });
  if (reconnected) {
    check('...and replays them exactly once, with no duplicated text',
      (after2.match(/MISSEDWHILEOFFLINE/g) || []).length === 1,
      (after2.match(/MISSEDWHILEOFFLINE/g) || []).length);
    const t1b = await liveText(page);
    check('the OTHER tab, cut at the same moment, also shows it exactly once',
      !!t1b && (t1b.match(/MISSEDWHILEOFFLINE/g) || []).length === 1,
      t1b && (t1b.match(/MISSEDWHILEOFFLINE/g) || []).length);
    // The replay window is the IN-FLIGHT turn only, so what arrived before the cut must still be
    // there: a reconnect that restarted the buffer instead of resuming it would have lost it.
    check('the reply from BEFORE the cut survived the reconnect (resumed, not restarted)',
      after2.includes('two tabs are watching'), after2.slice(0, 70));
  }
  await page2.close();

  // 9. End of turn, then reload: the finished reply appears exactly once.
  const full = await liveText(page);
  saveTurn(full);
  await endTurn(turn);
  await sleep(2000);
  const settled = await page.evaluate(() => [...document.querySelectorAll('.chatbox .m.claude .mb')].map(e => e.innerText));
  check('after the turn ends the reply is on screen exactly once',
    settled.filter(t => t.includes('MISSEDWHILEOFFLINE')).length === 1, settled.map(t => t.slice(-40)));
  check('no "not in the saved transcript yet" warning when the transcript does have it',
    (await page.locator('.cherr').count()) === 0, await page.locator('.cherr').allInnerTexts());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.chatbox', { timeout: 15000 });
  await sleep(1200);
  const afterReload = await page.evaluate(() => [...document.querySelectorAll('.chatbox .m.claude .mb')].map(e => e.innerText));
  check('after a reload the saved transcript shows that reply exactly once',
    afterReload.filter(t => t.includes('MISSEDWHILEOFFLINE')).length === 1,
    { fullLen: full && full.length, afterReload: afterReload.map(t => t.slice(-40)) });

  // The socket cut above is deliberate and every engine logs its own network error for it. Those
  // are this probe's noise; a JS error is the app's.
  const appErrors = consoleErrors.filter(t => !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_NETWORK_CHANGED|ERR_CONNECTION|Failed to load resource|network connection was lost|Load failed|Connection reset|failed to load/i.test(t));
  check('no uncaught JS errors in this engine', appErrors.length === 0, appErrors.slice(0, 5));
  if (consoleErrors.length !== appErrors.length) {
    note('network errors from the deliberate socket cut, ignored: '
      + JSON.stringify(consoleErrors.filter(t => !appErrors.includes(t)).slice(0, 3)));
  }
}

// ---- journey step 10: a message the agent never recorded ---------------------------------------
async function lost() {
  await page.goto(`${BASE}/ui/agents/${AGENT}`, { waitUntil: 'load' });
  await page.waitForSelector('.chat .chatf textarea', { timeout: 15000 });
  const r = await page.evaluate(async () => {
    const MSG = 'SENTINEL-' + Date.now() + ': what did your last run find?';
    const ta = document.querySelector('.chat .chatf textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, MSG);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const seen = [], t0 = performance.now();
    document.querySelector('.chat .chatf').requestSubmit();
    for (let i = 0; i < 120; i++) {
      await new Promise(x => setTimeout(x, 25));
      seen.push([Math.round(performance.now() - t0),
        [...document.querySelectorAll('.chatbox .m.me')].filter(e => e.innerText.includes(MSG)).length]);
    }
    return {
      msg: MSG,
      firstSeenMs: (seen.find(s => s[1] > 0) || [null])[0],
      everGone: seen.some(s => s[1] === 0),
      finalCount: seen[seen.length - 1][1],
      err: document.querySelector('.cherr')?.textContent || null,
      composer: document.querySelector('.chat .chatf textarea').value,
      busy: document.querySelector('.chat .chatf button').disabled,
    };
  });
  check('the message appears as a `you` bubble', r.firstSeenMs !== null, r);
  // The defect this covers: it appeared and was deleted 21 ms later, with .cherr null.
  check('...and is STILL there after the turn ends with nothing saved',
    r.finalCount === 1 && !r.everGone, r);
  check('the operator is TOLD the message was not saved',
    !!r.err && /was not saved/i.test(r.err), r.err);
  check('the warning says the message is temporary, not that it was kept',
    !!r.err && /until the transcript reloads/i.test(r.err), r.err);
  check('the text is handed back in the empty composer, so a retry is one click',
    r.composer === r.msg, { composer: r.composer, msg: r.msg });
  check('the composer is usable again, not wedged on "…"', r.busy === false, r);

  // It genuinely is not saved, so a reload must lose it — exactly as the warning said. A fix that
  // silently persisted it locally would have made that warning a lie.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.chatbox', { timeout: 15000 });
  await sleep(800);
  const gone = await page.evaluate(m => document.body.innerText.includes(m), r.msg);
  check('after a reload it is gone, exactly as the warning said it would be', gone === false, gone);
}

// ---- the harder half: the transcript ALREADY holds the text being sent -------------------------
// run.sh seeds it with MOWS_QA_SEED=status? for this mode. Matching by membership — asking "is this
// text anywhere in the transcript?" — calls the repeat saved because the earlier one was, and
// deletes it. Only a transcript that already contains the text can tell the two rules apart.
async function repeat() {
  await page.goto(`${BASE}/ui/agents/${AGENT}`, { waitUntil: 'load' });
  await page.waitForSelector('.chat .chatf textarea', { timeout: 15000 });
  const before = await page.evaluate(() => document.querySelectorAll('.chatbox .m.me').length);
  check('the transcript starts with exactly one saved "status?"', before === 1, before);

  const r1 = await sendMessage(page, 'status?');
  check('a REPEATED question survives the refetch', r1.users.filter(t => t.includes('status?')).length === 2, r1);
  check('...and the operator is told it was not saved', !!r1.err && /was not saved/i.test(r1.err), r1.err);
  check('...and the text is handed back to the composer', r1.composer === 'status?', r1.composer);

  // A later, unrelated turn must RETIRE it rather than re-append it under the new exchange. Keeping
  // it pending forever put a stale bubble at the bottom after every question and re-fired the alert.
  await page.evaluate(() => { document.querySelector('.chat .chatf textarea').value = ''; });
  const r2 = await sendMessage(page, 'a different question');
  check('on the NEXT turn the lost message is not re-appended below the new exchange',
    r2.users.filter(t => t.includes('status?')).length === 1, r2.users);
  check('...and the alert that fires is about the NEW message, not the old one',
    !!r2.err && /was not saved/i.test(r2.err) && r2.composer === 'a different question', r2);
  check('the transcript has not grown a stale copy', r2.users.length === 2, r2.users);
}

// ---- does the /ui policy actually STOP anything? ------------------------------------------------
// Run it against the dashboard as shipped (everything refused) and, to prove the probe is not
// blind, against a build with the header removed (everything runs). scripts/csp-admits.mjs covers
// the static half in CI; this is the half only a browser can answer.
async function csp() {
  const expectBlocked = process.env.MOWS_QA_CSP_EXPECT !== 'runs';
  await page.goto(`${BASE}/ui/agents`, { waitUntil: 'load' });
  await page.waitForSelector('a[href^="/ui/agents/"]', { timeout: 15000 });
  check('the SPA still renders (a CSP that breaks the app is not a win)',
    (await page.locator('a[href^="/ui/agents/"]').count()) > 0);

  const r = await page.evaluate(async () => {
    const o = { violations: [] };
    document.addEventListener('securitypolicyviolation', e => o.violations.push(e.violatedDirective));
    // 1. an inline event handler arriving through innerHTML — the exact shape of the C1 payload
    const d = document.createElement('div');
    d.innerHTML = '<img src="data:image/gif;base64,x" onerror="window.__pwnedAttr=1">';
    document.body.appendChild(d);
    // 2. a dynamically created inline <script>, which innerHTML cannot do but a chained payload can
    const s2 = document.createElement('script');
    s2.textContent = 'window.__pwnedInline=1';
    document.head.appendChild(s2);
    // 3. a script pulled from another origin
    const x = document.createElement('script');
    x.src = 'https://example.com/evil.js';
    document.head.appendChild(x);
    await new Promise(res => setTimeout(res, 1200));
    o.pwnedAttr = !!window.__pwnedAttr;
    o.pwnedInline = !!window.__pwnedInline;
    return o;
  });
  console.log(`OBSERVED: inline-handler ran=${r.pwnedAttr}, inline-script ran=${r.pwnedInline}, violations=${JSON.stringify(r.violations)}`);
  check('an injected inline event handler does not execute', r.pwnedAttr === !expectBlocked, r);
  check('a dynamically inserted inline <script> does not execute', r.pwnedInline === !expectBlocked, r);
  check('the engine reports the refusals as CSP violations',
    expectBlocked ? r.violations.length > 0 : r.violations.length === 0, r.violations);
}

// ---- do the SERVER-RENDERED pages still work under their baseline policy? -----------------------
async function baselinePages() {
  await page.addInitScript(() => {
    window.__v = [];
    document.addEventListener('securitypolicyviolation', e => window.__v.push(e.violatedDirective + ' ' + (e.blockedURI || '')));
  });
  const violations = [];
  for (const p of ['/', '/agents', '/history']) {
    const r = await page.goto(BASE + p, { waitUntil: 'load' }).catch(e => ({ status: () => 'threw: ' + e.message }));
    await sleep(700);
    violations.push(...(await page.evaluate(() => window.__v || [])).map(x => p + ' :: ' + x));
    check(`${p} still loads under the baseline policy`,
      typeof r.status === 'function' && [200, 302, 303].includes(r.status()), r && r.status && r.status());
  }
  check('no CSP violation on any server-rendered page', violations.length === 0, violations.slice(0, 6));
  // The point of stopping short of script-src/style-src there: these pages are full of both.
  const styled = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('inline styles still apply (the baseline names no style-src)',
    styled !== '' && styled !== 'rgba(0, 0, 0, 0)', styled);
}
