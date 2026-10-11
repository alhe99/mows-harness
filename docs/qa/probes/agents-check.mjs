// Cockpit phase 02b agents probe (specs/cockpit/02b-agents.md tasks 1, 2, 6). Exit code is the verdict.
// usage: node docs/qa/probes/agents-check.mjs <webkit|chromium> <list|detail|run|all>
// env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path; default: the repo's)
// Every mode runs against the /next shell on the dev instance with FIXTURE data: the boot snapshot is rewritten in flight, EventSource
// is replaced by a fake that window.__emit(name, data) drives, and every /api/agents/*, /a/* and /z request is answered here, so the
// probe cannot reach a real agent and does not depend on what the box holds. The chat itself (streaming, scroll, reconcile) is
// docs/qa/probes/run.sh against the fixture dashboard; this file is the pages around it.
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('agents-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'webkit';
const mode = process.argv[3] || 'all';
const MODES = ['list', 'detail', 'run'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`agents-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const browser = await pw[engine].launch();

let bad = 0, cur = '';
const errors = [];
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${mode === 'all' ? cur + ' ' : ''}${id}${detail === undefined || ok ? '' : ' ' + JSON.stringify(detail)}`); };

const NAME = 'harness-reviewer', RUN = '20260916-101500-1';
const pad = n => String(n).padStart(2, '0'), now = new Date();
const TODAY_RUN = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-173200-2473`;
const T = Date.now();
const iso = ago => new Date(T - ago * 1000).toISOString();
const AGENTS = [
  { name: 'alpha', state: 'done', last_event_at: iso(7200), total: 3, cost7d: 1.5 },
  { name: 'beta', state: 'working', last_event_at: iso(1500), total: 1, cost7d: 0.25 },
  { name: 'gamma', state: null, last_event_at: null, total: 0, cost7d: 0 },
];
const CAP = { policy: { model: 'sonnet', profile: 'default', soul: 'pr-reviewer', workdir: '~/proj', triggerTypes: ['cron', 'webhook'],
    budget: { usd_per_run: 1.5, max_turns: 40, usd_per_day: 6 }, permissionMode: 'default' },
  effective: ['Read', 'Grep', 'Bash'], authorities: [{ kind: 'shell', tools: ['Bash'] }], inherits: false };
const DETAIL = { name: NAME, total: 2, cost7d: 1.5, timers: [], timer: { state: 'none', label: '' }, capability: CAP, memory: 'remembered: the repo uses tabs',
  recs: [{ run_id: TODAY_RUN, state: 'working', cost_usd: 0.5 }, { run_id: RUN, state: 'done', cost_usd: 0.21 }],
  events: [`${iso(300)} run started`, `${iso(200)} chat turn (streamed): $0.02`, `${iso(100)} memory truncated`] };
const CHAT = { turns: [{ at: iso(600), role: 'user', text: 'What did the last run find?' },
  { at: iso(590), role: 'assistant', text: 'Two **shell-quoting** issues.\n\n- one\n- two', cost_usd: 0.01 }] };
const RUNFX = { status: { state: 'done', cost_usd: 0.21, turns: 4, run_id: RUN }, text: 'First paragraph of the run.\n\nSecond one with <b>tags</b> shown as text.\n\n' };

async function open(opts = {}) {
  const { w = 1280, h = 800, agents = AGENTS, api = {} } = opts;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    const all = (window.__es = []);
    window.EventSource = class {
      constructor(url) { this.url = url; this.readyState = 1; this.l = {}; all.push(this); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); }
      addEventListener(n, f) { (this.l[n] ||= []).push(f); }
      close() { this.readyState = 2; }
    };
    window.__emit = (name, data) => all.forEach(e => (e.l[name] || []).forEach(f => f({ data: JSON.stringify(data), lastEventId: '' })));
  });
  await ctx.route('**/next/**', async route => {
    const r = await route.fetch();
    if (!(r.headers()['content-type'] || '').includes('text/html')) return route.fulfill({ response: r });
    const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => {
      const b = JSON.parse(j); b.agents = agents;
      return a + JSON.stringify(b).replace(/</g, '\\u003c') + c;
    });
    const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length'];
    await route.fulfill({ status: r.status(), headers, body: html });
  });
  const seen = { api: [], posts: [], scripts: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(/\/api\/agents(\/|$|\?)/, route => {
    const p = new URL(route.request().url()).pathname;
    seen.api.push(p);
    const hit = api[p];
    if (hit !== undefined) return hit === 404 ? json(route, 404, {}) : json(route, 200, hit);
    if (p === '/api/agents') return json(route, 200, { agents });
    if (p === `/api/agents/${NAME}`) return json(route, 200, DETAIL);
    if (p === `/api/agents/${NAME}/chat`) return json(route, 200, CHAT);
    if (p === `/api/agents/${NAME}/runs/${RUN}`) return json(route, 200, RUNFX);
    return json(route, 404, {});
  });
  await ctx.route('**/a/**', route => { seen.posts.push(route.request().url()); return route.fulfill({ status: 204 }); });
  await ctx.route('**/z?*', route => route.fulfill({ status: 204 }));
  const page = await ctx.newPage();
  // the 404 a fixture answers on purpose ("No such run.", an unknown agent after a list card click) is logged by the engine; it is the probe's, not the app's
  const deliberate = m => /\/api\/agents\/[^/]+(\/runs\/.*)?$/.test(m.location().url || '') && /404/.test(m.text());
  page.on('console', m => { if (m.type() === 'error' && !/interactive-widget/.test(m.text()) && !deliberate(m)) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (/\/assets\/.*\.mjs$/.test(r.url())) seen.scripts.push(r.url().split('/').pop()); });
  let loads = 0; page.on('load', () => loads++);
  return { ctx, page, seen, loads: () => loads };
}
const text = (page, sel) => page.locator(sel).first().innerText().then(t => t.replace(/\s+/g, ' ').trim());

async function list() {
  const { ctx, page, loads } = await open();
  await page.goto(DASH + '/next/agents', { waitUntil: 'load' });
  await page.waitForSelector('a.agent.card');
  const rows = await page.$$eval('a.agent.card', as => as.map(a => ({ href: a.getAttribute('href'), name: a.querySelector('b')?.textContent,
    pill: a.querySelector('.pill')?.className, pillText: a.querySelector('.pill')?.textContent, meta: a.querySelector('.muted')?.textContent })));
  check('1 one a.agent.card per agent, linked into the shell', rows.length === 3 && rows.every((r, i) => r.href === `/next/agents/${AGENTS[i].name}`), rows);
  check('2 the pill is the state, "never" when there is none', rows[0].pill === 'pill st-done' && rows[0].pillText === 'done' && rows[2].pill === 'pill st-never' && rows[2].pillText === 'never', rows.map(r => [r.pill, r.pillText]));
  check('3 "<rel> · N runs · 7d $x", "never ran" without a last event', rows[0].meta === '2h ago · 3 runs · 7d $1.50' && rows[1].meta === '25m ago · 1 runs · 7d $0.25' && rows[2].meta === 'never ran · 0 runs · 7d $0.00', rows.map(r => r.meta));
  check('4 the title is the h1 "agents" and the body is the 1088 px column', (await text(page, '[data-view=agents] h1')) === 'agents' && await page.evaluate(() => document.body.classList.contains('uiapp')));
  // the stream sends a FULL snapshot: membership follows it
  await page.evaluate(([a]) => window.__emit('agents', a), [[AGENTS[1], { name: 'delta', state: 'failed', last_event_at: null, total: 2, cost7d: 3 }]]);
  await page.waitForFunction(() => document.querySelectorAll('a.agent.card').length === 2);
  const names = await page.$$eval('a.agent.card b', bs => bs.map(b => b.textContent));
  check('5 an agents event replaces the list: a removed agent goes, a new one appears', names.join() === 'beta,delta', names);
  const before = loads();
  await page.click('a.agent.card >> nth=0');
  await page.waitForFunction(() => location.pathname === '/next/agents/beta');
  check('6 a card opens the agent inside the shell, no document load', loads() === before && await page.evaluate(() => !!document.querySelector('#app')));
  await ctx.close();
  const e = await open({ agents: [] });
  await e.page.goto(DASH + '/next/agents', { waitUntil: 'load' });
  await e.page.waitForFunction(() => document.querySelector('#app')?.textContent === 'No agents yet.');
  check('7 no agents: the string "No agents yet."', true);
  await e.ctx.close();
}

async function detail() {
  const { ctx, page, seen } = await open();
  await page.goto(DASH + '/next/agents', { waitUntil: 'load' });
  await page.waitForSelector('a.agent.card');
  check('8 the capability chunk is not fetched by the list', !seen.scripts.some(s => /^capability\./.test(s)), seen.scripts);
  await page.goto(DASH + `/next/agents/${NAME}`, { waitUntil: 'load' });
  await page.waitForSelector('.chatbox .m');
  await page.waitForSelector('details.capmore .cap', { state: 'attached' });
  check('9 the capability panel is its own lazy chunk, fetched by the agent view', seen.scripts.some(s => /^capability\./.test(s)), seen.scripts);
  check('10 .agwrap > .ag2 holds the chat card and the aside', await page.evaluate(() => !!document.querySelector('.agwrap > .ag2 > section.agchat') && !!document.querySelector('.agwrap > .ag2 > aside.agside')));
  const cards = await page.$$eval('.agside > .card > .cl, .agside > details.card > summary', es => es.map(e => e.textContent));
  check('11 five aside cards, in order, with the exact titles', cards.join('|') === 'Agent Telemetry|Capabilities|Recent Runs|Memory|Events', cards);
  check('12 header: name, running dot, "<model> · $x spent"', (await text(page, '.agh h1')) === NAME && await page.locator('.agh .agdot').count() === 1 && (await text(page, '.agsub')) === 'sonnet · $1.50 spent');
  const rows = await page.$$eval('.tgrid .trow', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  check('13 telemetry rows: Profile Soul Target Trigger Budget Daily Cap', rows.join('|') === 'Profile default|Soul pr-reviewer|Target ~/proj|Trigger cron, webhook|Budget $1.50 / 40 turns|Daily Cap $6.00 per day', rows);
  check('14 capabilities: chips of the effective tools, then the strongest authority', (await page.$$eval('.cchips .cchip', e => e.map(x => x.textContent))).join() === 'Read,Grep,Bash' && (await text(page, '.capsum-warn')) === 'Shell execution granted.');
  check('15 the full report sits behind the disclosure, shut', await page.evaluate(() => !document.querySelector('details.capmore').open) && /What this agent can do/.test(await page.locator('details.capmore .cap h2').textContent()));
  const runs = await page.$$eval('.rruns li', ls => ls.map(l => [l.querySelector('a').textContent, l.querySelector('a').title, l.querySelector('a').getAttribute('href'), l.querySelector('.rcost').textContent]));
  check('16 recent runs: today = HH:MM-pid, older carry MM-DD; full id in the title; link into the shell',
    runs[0][0] === '17:32-2473' && runs[1][0] === '09-16 10:15-1' && runs[0][1] === TODAY_RUN && runs[1][2] === `/next/agents/${NAME}/${RUN}` && runs[0][3] === '$0.50' && runs[1][3] === '$0.21', runs);
  check('17 memory in a <pre>, events collapsed in a details with the raw lines', (await text(page, 'pre.mem')) === 'remembered: the repo uses tabs' && await page.evaluate(() => !document.querySelector('details.agev').open) && (await page.locator('pre.events').textContent()).split('\n').length === 3);
  check('18 the hint line names the effective tools', (await text(page, 'p.chint')) === `${NAME} has access to Read, Grep, Bash. Use /help for commands.`);
  const form = await page.$eval('form.agctl', f => ({ action: f.getAttribute('action'), method: f.method, back: f.querySelector('[name=back]').value, name: f.querySelector('[name=name]').value, label: f.querySelector('button').getAttribute('aria-label') }));
  check('19 Run now is a plain POST form to /a/agent-run that comes back to the shell page', form.action === '/a/agent-run' && form.method === 'post' && form.back === `/next/agents/${NAME}` && form.name === NAME && form.label === 'Run now', form);
  check('20 the transcript renders its markdown, the chat footer is the composer', await page.evaluate(() => !!document.querySelector('.chatbox .m.claude .mb strong') && document.querySelectorAll('.chatbox .m.me').length === 1 && !!document.querySelector('.chat .chatf textarea[required]')));
  check('21 html.agent-view is set while the view is mounted, and the page is the --kb/uiapp card', await page.evaluate(() => document.documentElement.classList.contains('agent-view') && document.body.classList.contains('uiapp')));
  await page.focus('.chat .chatf textarea');
  check('22 focusing the composer sets html.kb-open (the tab bar hides)', await page.evaluate(() => document.documentElement.classList.contains('kb-open')));
  await page.evaluate(() => document.activeElement.blur());
  check('23 ...and blur clears it', await page.evaluate(() => !document.documentElement.classList.contains('kb-open')));
  await page.click('a.agback');
  await page.waitForFunction(() => location.pathname === '/next/agents' && !document.documentElement.classList.contains('agent-view'), null, { timeout: 5000 }).catch(() => {});
  check('24 the ← agents link goes back inside the shell and clears html.agent-view', await page.evaluate(() => location.pathname === '/next/agents' && !document.documentElement.classList.contains('agent-view')));
  await ctx.close();
  // an agent whose file cannot be read, never run, with no memory: every card says so in words
  const u = await open({ api: { [`/api/agents/${NAME}`]: { ...DETAIL, capability: null, memory: null, recs: [], events: [] } } });
  await u.page.goto(DASH + `/next/agents/${NAME}`, { waitUntil: 'load' });
  await u.page.waitForSelector('.agside .card');
  const t = await u.page.$$eval('.agside .card', cs => cs.map(c => c.innerText.replace(/\s+/g, ' ').trim()));
  check('25 unknown capability, no runs, no memory: stated, never a confident dash',
    /could not be read, so nothing here is known/.test(t[0]) && /Its agent file could not be read\./.test(t[1]) && /Never run\./.test(t[2]) && /No memory yet\./.test(t[3]) && !(await u.page.locator('p.chint').count()), t);
  await u.ctx.close();
  const c = await open({ api: { [`/api/agents/${NAME}`]: { ...DETAIL, memory: '' } } });
  await c.page.goto(DASH + `/next/agents/${NAME}`, { waitUntil: 'load' });
  await c.page.waitForSelector('.agside .card');
  check('26 a memory the agent cleared reads "Cleared by the agent."', /Cleared by the agent\./.test(await c.page.locator('.agside .card >> nth=3').innerText()));
  await c.ctx.close();
  const m = await open({ w: 390, h: 844, api: { [`/api/agents/${NAME}`]: { ...DETAIL, capability: { ...CAP, inherits: true, effective: null } } } });
  await m.page.goto(DASH + `/next/agents/${NAME}`, { waitUntil: 'load' });
  await m.page.waitForSelector('.chatbox .m');
  check('27 an inheriting agent: "Inherits every tool" and no hint line', /Inherits every tool/.test(await text(m.page, '.capsum-in')) && !(await m.page.locator('p.chint').count()));
  check('28 390 px: the placeholder is the short one, no horizontal overflow', (await m.page.getAttribute('.chatf textarea', 'placeholder')) === `Ask ${NAME}…` && await m.page.evaluate(() => document.scrollingElement.scrollWidth <= 390));
  await m.ctx.close();
}

async function run() {
  const { ctx, page, loads } = await open();
  await page.goto(DASH + `/next/agents/${NAME}/${RUN}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-view=run] .m.claude pre');
  check('29 the status block: state pill, cost, turns', (await text(page, '[data-view=run] p')) === 'done $0.21 · 4 turns' && await page.locator('[data-view=run] p .pill.st-done').count() === 1);
  check('30 the heading links back to the agent, inside the shell, with the run id', (await text(page, '[data-view=run] h1')) === `← ${NAME} · ${RUN}` && (await page.getAttribute('[data-view=run] h1 a', 'href')) === `/next/agents/${NAME}`);
  check('31 the assistant text is shown as text in a <pre>, tags not interpreted', (await page.locator('.m.claude pre').textContent()).startsWith('First paragraph of the run.') && await page.locator('.m.claude pre b').count() === 0 && (await page.locator('.m.claude .mh b').textContent()) === NAME);
  const before = loads();
  await page.click('[data-view=run] h1 a');
  await page.waitForFunction(p => location.pathname === p, `/next/agents/${NAME}`);
  check('32 the heading link is followed inside the shell, no document load', loads() === before);
  await ctx.close();
  const e = await open({ api: { [`/api/agents/${NAME}/runs/${RUN}`]: { status: { state: 'failed', cost_usd: 0, turns: 1 }, text: '' } } });
  await e.page.goto(DASH + `/next/agents/${NAME}/${RUN}`, { waitUntil: 'load' });
  await e.page.waitForSelector('.m.claude pre');
  check('33 no assistant text: "(no assistant text)"', (await text(e.page, '.m.claude pre')) === '(no assistant text)' && await e.page.locator('[data-view=run] .pill.st-failed').count() === 1);
  await e.ctx.close();
  const g = await open({ api: { [`/api/agents/${NAME}/runs/${RUN}`]: 404 } });
  await g.page.goto(DASH + `/next/agents/${NAME}/${RUN}`, { waitUntil: 'load' });
  await g.page.waitForFunction(() => document.querySelector('#app')?.textContent === 'No such run.');
  check('34 an unknown run: "No such run."', true);
  await g.ctx.close();
}

const todo = mode === 'all' ? MODES : [mode];
for (const m of todo) { cur = m; await { list, detail, run }[m](); }
check('35 no console errors, no uncaught exceptions', errors.length === 0, errors.slice(0, 5));
await browser.close();
console.log(bad ? `agents-check ${engine} ${mode}: ${bad} FAILED` : `agents-check ${engine} ${mode}: all passed`);
process.exit(bad ? 1 : 0);
