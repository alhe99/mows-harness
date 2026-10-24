// commands.mjs — GET /app/commands.json?tab=<8 hex>[&s=<session>]: the slash commands of the session a terminal tab shows, for the phone
// composer's "/" menu (web/pages/term/composer.mjs). Claude Code's own commands (BUILTIN below: the "All commands" table of
// code.claude.com/docs/en/commands as of 2026-10-24, the removed ones left out; refresh it from that page) and, read from disk the way Claude
// reads them, the skills and commands of the session's account (<home>/skills/*/SKILL.md, <home>/commands/**/*.md), of its project (.claude/
// in the pane's directory and its parents up to the user's home) and of the account's enabled plugins (named plugin:name). Only names,
// argument hints and descriptions, from the files' frontmatter; a skill marked user-invocable: false is left out. Cached 60 s per account
// and directory. The dashboard runs as root; the reading itself does not: cmdscan.mjs runs as the tmux user (see its header).
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ACCTS, TMUX_HOME, TMUX_USER, fleetState, sh, tmuxLive, userCmd } from '../core.mjs';

/** [name, argument hint, what it does, kind if not a built-in command] */
export const BUILTIN = [
  ["add-dir", "<path>", "Add a working directory for file access during the current session"],
  ["advisor", "[model|off]", "Enable or disable the advisor tool, which consults a second model for guidance at key…"],
  ["agents", "", "Print a reminder to ask Claude to create or manage subagents, or to edit…"],
  ["artifact-capabilities", "", "**Skill.** Load the reference for the runtime capabilities a published artifact can…"],
  ["artifact-diagramming", "", "**Skill.** Load diagramming guidance for Claude to follow in artifacts: when a diagram…"],
  ["artifacts", "", "List the artifacts you own or that are shared with you, then attach one to the session,…"],
  ["auto-mode-setup", "", "Draft autoMode.environment entries from your project and recent sessions, then review…"],
  ["autocompact", "[auto|<tokens>]", "Set the auto-compact window: how full the context window gets before Claude Code…"],
  ["autofix-pr", "[prompt]", "Spawn a cloud session that watches the current branch's PR and pushes fixes when CI…"],
  ["background", "[prompt]", "Detach the current session to run as a background agent and free this terminal"],
  ["batch", "<instruction>", "**Skill.** Orchestrate large-scale changes across a codebase in parallel"],
  ["branch", "[name]", "Create a branch of the current conversation at this point, so you can try a different…"],
  ["btw", "[question]", "Ask a side question about the current session without adding to the conversation"],
  ["bug", "[report]", "Report a bug or share your conversation"],
  ["cd", "<path>", "Move this session to a new working directory, keeping the conversation"],
  ["chrome", "", "Configure Claude in Chrome settings"],
  ["claude-api", "[migrate|upgrade|api-version|managed-agents-onboard|managed-agents-secure|prompt-audit|cost-optimize|build-eval|hillclimb|preserved-thinking-migration]", "**Skill.** Load Claude API and Managed Agents reference material for your project's…"],
  ["claude-in-chrome", "[task]", "**Skill.** Have Claude carry out a task in your browser, such as testing a page,…"],
  ["clear", "[name]", "Start a new conversation with empty context"],
  ["code-review", "[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [--max-findings n|all|default] [pr#|branch|path]", "**Skill.** Review the current diff, or a PR number, branch, or path you pass, for…"],
  ["color", "[color|default]", "Set the prompt bar color for the current session"],
  ["compact", "[instructions]", "Free up context by summarizing the conversation so far"],
  ["config", "[key=value ...]", "Open the Settings interface to adjust theme, model, output style, and other preferences"],
  ["context", "[all]", "Visualize current context usage as a colored grid"],
  ["copy", "[N]", "Copy the last assistant response to clipboard"],
  ["cost", "", "Alias for /usage"],
  ["dataviz", "[request]", "**Skill.** Design guidance for charts, graphs, and dashboards"],
  ["debug", "[description]", "**Skill.** Enable debug logging for the current session and troubleshoot issues by…"],
  ["deep-research", "<question>", "**Workflow.** Fan out web searches on a question, fetch and cross-check sources, and…"],
  ["design", "[brief]", "**Skill.** Draft UI mockups, screen flows, landing pages, or posters as artboards on…"],
  ["design-login", "", "Authorize design-system access for /design-sync with your claude.ai account"],
  ["design-sync", "[hint]", "**Skill.** Convert your repo's React design system and upload it to Claude Design, so…"],
  ["desktop", "", "Continue the current session in the Claude Code Desktop app"],
  ["diff", "", "Review the changes in your working tree, including the edits Claude has made so far"],
  ["doctor", "[prompt-audit [path]]", "**Skill.** Run a setup checkup that diagnoses installation, settings, extension, and…"],
  ["effort", "[level|auto|status|ultracode [on|off]]", "Set the effort level: low to xhigh, max, or auto; status prints it"],
  ["exit", "", "Exit the CLI"],
  ["export", "[filename]", "Export the current conversation as plain text"],
  ["fast", "[on|off]", "Toggle fast mode on or off"],
  ["feedback", "[report]", "Send product feedback about Claude Code"],
  ["fewer-permission-prompts", "", "**Skill.** Scan your transcripts for common read-only Bash and MCP tool calls, then add…"],
  ["focus", "", "Toggle the focus view, which shows only your last prompt, a one-line tool-call summary…"],
  ["fork", "[prompt]", "Copy the current conversation into a new background session and keep working here"],
  ["goal", "[condition|clear]", "Set a goal: Claude keeps working across turns until the condition is met or the goal…"],
  ["heapdump", "", "Write a JavaScript heap snapshot and a memory breakdown to ~/Desktop, or your home…"],
  ["help", "", "Show help and available commands"],
  ["hooks", "", "View hook configurations"],
  ["ide", "", "Manage IDE integrations and show status"],
  ["import", "[codex|gemini|cursor] [--dry-run] [--yes]", "Bring configuration from OpenAI Codex, Google Gemini CLI, or Cursor on your machine…"],
  ["init", "", "Initialize project with a CLAUDE.md guide"],
  ["insights", "", "Generate an HTML report analyzing your recent sessions on this machine: which projects…"],
  ["install-github-app", "", "Install the Claude GitHub App for a repository, with an optional step to set up GitHub…"],
  ["install-slack-app", "", "Install the Claude Slack app"],
  ["keybindings", "", "Open your keyboard shortcuts file"],
  ["list-agents", "", "List the subagents, agent team teammates, and other Claude Code sessions Claude can…"],
  ["login", "", "Sign in to your Anthropic account"],
  ["logout", "", "Sign out from your Anthropic account"],
  ["loop", "[interval] [prompt]", "**Skill.** Run a prompt repeatedly while the session stays open"],
  ["mcp", "[reconnect (<server>|all)|enable|disable [<server>|all]]", "Manage MCP server connections and OAuth authentication"],
  ["memory", "", "Edit CLAUDE.md files, enable or disable auto memory, and view auto memory entries"],
  ["mobile", "", "Show QR code to download the Claude mobile app"],
  ["model", "[model]", "Switch the AI model and save it as your default for new sessions"],
  ["output-style", "[style]", "List output styles or switch to one, for example /output-style concise"],
  ["passes", "", "Share a free week of Claude Code with friends"],
  ["permissions", "", "Manage allow, ask, and deny rules for tool permissions"],
  ["plan", "[description]", "Enter plan mode directly from the prompt"],
  ["plugin", "[subcommand]", "Manage Claude Code plugins"],
  ["plugin-authoring", "", "Load the reference Claude works from to write a mod"],
  ["powerup", "", "Discover Claude Code features through quick interactive lessons with animated demos"],
  ["privacy-settings", "", "View and update your privacy settings"],
  ["radio", "", "Open Claude FM lo-fi radio in your browser"],
  ["rate-limit-options", "", "Show ways to keep working when a claude.ai usage limit blocks a request: wait and…"],
  ["recap", "", "Generate a one-line summary of the current session on demand"],
  ["release-notes", "", "View the changelog in an interactive version picker"],
  ["reload-plugins", "[--force]", "Reload all active plugins to apply pending changes without restarting"],
  ["reload-skills", "", "Re-scan skill and command directories so skills added or changed on disk during the…"],
  ["remote-control", "", "Make this session available for Remote Control from claude.ai"],
  ["remote-env", "", "Choose the default cloud environment for cloud sessions you start from the CLI"],
  ["rename", "[name]", "Rename the current session and show the name on the prompt bar"],
  ["resume", "[session]", "Resume a conversation by ID or name, or open the session picker"],
  ["review", "[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [--max-findings n|all|default] [pr#|branch|path]", "Alias of /code-review: reviews the current diff, or a PR number, branch, or path you…"],
  ["rewind", "", "Rewind the conversation and/or code to a previous point, or summarize from a selected…"],
  ["run", "", "**Skill.** Launch and drive your project's app to see a change working, not only…"],
  ["run-skill-generator", "", "**Skill.** Teach /run and /verify how to build, launch, and drive your project's app…"],
  ["sandbox", "", "Toggle sandbox mode"],
  ["schedule", "[description]", "Create, update, list, or run cloud scheduled tasks, formerly routines"],
  ["scroll-speed", "", "Adjust mouse wheel scroll speed interactively"],
  ["security-review", "", "Analyze the changes on your current branch for security vulnerabilities"],
  ["setup-bedrock", "", "Configure Amazon Bedrock authentication, region, and model pins through an interactive…"],
  ["setup-vertex", "", "Configure Google Cloud's Agent Platform authentication, project, region, and model pins…"],
  ["simplify", "[target]", "**Skill.** Review the changed code for cleanup opportunities and apply the fixes"],
  ["skill-doctor", "", "Show what each of your skills costs in context and how often it gets used, so you can…"],
  ["skills", "", "List available skills"],
  ["slides", "[brief]", "**Skill.** Make a new presentation as a Claude Slides artifact filled from your brief,…"],
  ["stats", "", "Alias for /usage"],
  ["status", "", "Open the Settings interface on the Status tab, showing version, model, account, and…"],
  ["statusline", "", "Configure Claude Code's status line"],
  ["stickers", "", "Order Claude Code stickers"],
  ["stop", "", "Stop the background session you're attached to, or the one you send it to as a peek…"],
  ["subtask", "<task>", "Spawn a forked subagent: a background subagent that inherits the full conversation and…"],
  ["tasks", "", "View and manage background work in the current session, including subagents that have…"],
  ["team-onboarding", "", "Generate a team onboarding guide from your Claude Code usage history"],
  ["teleport", "", "Pull a cloud session into this terminal"],
  ["terminal-setup", "", "Install a Shift+Enter keybinding for newlines in VS Code, Cursor, Devin Desktop,…"],
  ["theme", "", "Change the color theme"],
  ["tui", "[default|fullscreen]", "Set the terminal UI renderer and relaunch into it with your conversation intact"],
  ["ultrareview", "[PR or branch]", "Run a deep, multi-agent code review in a cloud sandbox with ultrareview"],
  ["update-config", "[request]", "**Skill.** Describe a settings change, such as allowing a command, setting an…"],
  ["upgrade", "", "Open the upgrade page in your browser to switch to a higher plan tier"],
  ["usage", "", "Show session cost, plan usage limits, and activity stats"],
  ["usage-credits", "", "Configure usage credits, or request them from your admin, when you hit a limit"],
  ["verify", "", "**Skill.** Confirm a code change does what it should by building your project's app,…"],
  ["voice", "[hold|tap|off]", "Toggle voice dictation, or enable it in a specific mode"],
  ["web-setup", "", "Connect your GitHub account for cloud sessions using your local gh CLI credentials"],
  ["workflow-authoring", "", "**Skill.** Load the reference for writing dynamic workflow scripts: the script API,…"],
  ["workflows", "", "Open the workflow progress view to watch, pause, resume, or save running and completed…"]
];

const cache = new Map();
const SCANNER = fileURLToPath(new URL('./cmdscan.mjs', import.meta.url));
/** the commands for one account home and pane directory: BUILTIN, then what the scanner finds, run as the tmux user (cmdscan.mjs) */
export async function commandsFor(home, cwd) {
  const key = home + '\0' + cwd, hit = cache.get(key);
  if (hit && Date.now() - hit.t < 60000) return hit.list;
  let found = [];
  try { found = JSON.parse(await sh(...userCmd([process.execPath, SCANNER, '--scan', home, cwd, TMUX_HOME])) || '[]'); } catch {}
  const seen = new Set(), list = [];
  for (const c of [...BUILTIN.map(([n, a, d, k]) => [n, a, d, k || 'built-in']), ...(Array.isArray(found) ? found : [])])
    if (Array.isArray(c) && typeof c[0] === 'string' && !seen.has(c[0])) { seen.add(c[0]); list.push(c.slice(0, 4).map(x => String(x ?? ''))); }
  cache.set(key, { t: Date.now(), list });
  return list;
}

/** the tmux session a terminal tab shows: web-term.sh wrote the tab's tty under its id; the client on that tty names the session */
export async function tabSession(tab) {
  let tty = '';
  try { tty = (await fsp.readFile(path.join(TMUX_HOME, '.cache', 'webterm-clients', tab), 'utf8')).trim(); } catch {}
  if (!tty) return '';
  const out = await sh(...userCmd(['tmux', 'list-clients', '-F', '#{client_tty}\t#{session_name}']));
  for (const l of out.trim().split('\n')) { const [t, n] = l.split('\t'); if (t === tty) return n; }
  return '';
}

export async function commandsJson(req, res, url) {
  const tab = url.searchParams.get('tab') || '', want = url.searchParams.get('s') || '';
  const live = await tmuxLive();
  let name = /^[0-9a-f]{8}$/.test(tab) ? await tabSession(tab) : '';
  if (!name && live.some(l => l.name === want)) name = want; // the URL's own session, when the tab is not registered (yet)
  const l = live.find(x => x.name === name);
  const row = l ? (await fleetState()).find(f => f.name === name) : null;
  const mine = ACCTS.filter(a => a.user === TMUX_USER);
  const acct = mine.find(a => a.id === row?.a) || mine[0];
  const list = acct ? await commandsFor(acct.home, (l && l.cwd) || TMUX_HOME) : BUILTIN.map(([n, a, d, k]) => [n, a, d, k || 'built-in']);
  const buf = Buffer.from(JSON.stringify({ session: name, cmds: list }));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
}
