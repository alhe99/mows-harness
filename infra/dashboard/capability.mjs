// What an agent can EFFECTIVELY do, derived from its frontmatter — never the deny list as written
// (spec D5, §5). An agent with Bash can write any file its OS account can reach no matter what
// disallowedTools says, so a panel that computed "read-only" from the deny list would mislead
// precisely when it matters most: harness-reviewer denies Write, Edit, WebFetch and NotebookEdit
// and not one of those four is in its tools list, so the deny list removes nothing at all while
// looking like the whole safety story.
//
// This lives in its own module rather than inside lite.mjs so scripts/capability-check.mjs can
// exercise THIS function instead of a copy of it — importing lite.mjs starts an HTTP listener.
// Same split, and the same reason, as infra/dashboard/chat-stream.mjs.

// ---------------------------------------------------------------------------------------------
// AUTHORITIES, not one boolean.
//
// Round 1 modelled capability as a single `hasBroad` flag over {Bash, Task}. That is the right
// answer to "does anything exceed the tool list" and the wrong shape for a panel titled "What this
// agent can do": `tools: [Read, Write, Edit, WebFetch]` rendered completely silent, so an agent
// that can overwrite ~/.claude/settings.json or another agent's own .md file — and then send what
// it read off this box — produced the panel's most reassuring output. The task's premise is that
// several narrow-sounding tools add up; one flag cannot name what they add up TO.
//
// So each kind of authority is named separately, with the tools that confer it.
//
//   beyondList: true  — reaches tools the list does not name, so the list is not a bound at all.
//                       Bash runs anything. Task hands a subagent its own tool list, which the
//                       parent's disallowedTools does not reach. A project slash command's own
//                       frontmatter can carry `allowed-tools: Bash`.
//   beyondList: false — real authority, bounded by the list. Still worth naming: "it can write
//                       files" and "it can reach the network" are the two things an operator most
//                       needs to know, and neither was said anywhere in round 1.
//
// Ordered strongest first; the panel renders them in this order and the order is the message.
export const AUTHORITIES = [
  { kind: 'shell', beyondList: true, tools: ['Bash'] },
  { kind: 'subagent', beyondList: true, tools: ['Task'] },
  { kind: 'command', beyondList: true, tools: ['SlashCommand'] },
  { kind: 'write', beyondList: false, tools: ['Write', 'Edit', 'NotebookEdit'] },
  { kind: 'network', beyondList: false, tools: ['WebFetch', 'WebSearch'] },
];
const AUTH_TOOLS = AUTHORITIES.flatMap(a => a.tools);
// Tools whose reach this page is willing to vouch for as read-only or purely internal. It exists
// only so that the "unclassified" report below is not a list of every tool in Claude Code — and it
// is deliberately SHORT. Anything absent from both this set and AUTHORITIES is reported as unknown,
// which errs toward saying "I cannot tell you" rather than toward silence.
//
// The measurement that forced this, pinned in scripts/fixtures/inherited-tools.json so the numbers
// are gated rather than asserted in a comment: an inheriting agent on this box was granted 27 tools,
// of which AUTHORITIES matches 7 (SlashCommand was not among them) and BENIGN_TOOLS matches 1
// (Read) — 8 classified, 19 not. The 19 included CronCreate, ScheduleWakeup, RemoteTrigger,
// SendMessage, EnterWorktree and Workflow: none plausibly read-only, none nameable in advance.
// A fixed allowlist of dangerous names can only ever be behind a tool surface that grows, so the
// panel must report the residue instead of treating "not on my list" as "harmless".
const BENIGN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'BashOutput', 'ExitPlanMode']);
const MCP_RE = /^mcp__/;
// The beyond-the-list tools, which is what the brief's `broad` field means. This is a SUPERSET of
// mows-agent-meta's WRITE_CAPABLE_TOOLS ({Bash, Task}), not a copy of it, and
// scripts/capability-check.mjs parses that set out of the validator and asserts the containment
// rather than comparing against a literal. The direction that matters is "anything the linter
// calls write-capable is at least as serious here", so hardening the linter can never leave this
// panel the laxer of the two. (Round 1 claimed the sets were identical and asserted it against a
// hardcoded string: the reviewer widened WRITE_CAPABLE_TOOLS and the check stayed green.)
export const BROAD_TOOLS = new Set(AUTHORITIES.filter(a => a.beyondList).flatMap(a => a.tools));

// null means "the key is present but is not a tool list" — a state that must NOT collapse into the
// empty list, because an empty list reads as "no tools" and unparseable input is not that.
// BOTH BRANCHES TRIM, and the array branch refuses a non-string entry (Task 9, found by fuzzing).
// It used to be `v.map(String)`, and the two branches then disagreed about the same declaration:
//   tools: "Read, Bash"       -> [Read, Bash]  -> hasBroad TRUE
//   tools: ["Read", "Bash "]  -> [Read, Bash ] -> hasBroad FALSE, and the shell authority was
//                                                 reported instead as "a tool whose reach this
//                                                 page cannot state".
// One trailing space, written in the other of two equally ordinary YAML syntaxes, and the panel
// stopped naming the shell -- in the FLATTERING direction, which is the one this module exists to
// rule out. No hand-written fixture had ever used the array syntax with stray whitespace.
//
// `v.map(String)` was worse than untidy on a NON-STRING entry. `- Bash:` instead of `- Bash` is a
// one-character YAML typo and parses as {Bash: null}, which stringified to "[object Object]": the
// panel then gave a CONFIDENT, non-inheriting tool list for a file it had not understood, and said
// the agent had no shell authority. Such an array is now unreadable (null), which routes it to
// malformedTools below and rounds toward UNRESTRICTED -- the rule this module already states for
// every other unparseable value, applied at last to this one.
const asList = v => Array.isArray(v)
  ? (v.every(x => typeof x === 'string') ? v.map(s => s.trim()).filter(Boolean) : null)
  : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean)
  : null;

export function agentCapability(fm, opts = {}) {
  const rawTools = fm?.tools, rawDenied = fm?.disallowedTools;
  const deniedList = asList(rawDenied);
  const tools = asList(rawTools), denied = new Set(deniedList || []);
  // A Claude Code file-based subagent with NO `tools:` key inherits every tool the main thread has
  // — including Bash. Reporting that as `effective: []` ("Tools: none") would invert the truth on
  // the one shape where being wrong is worst: the file that looks most restricted is the least.
  // An empty or comma-only STRING is unreadable input, not a restriction: `asList` splits, trims and
  // filters, so `''` and `', ,'` both collapse to `[]` and would otherwise render the panel's most
  // reassuring output ("Tools its file grants: none") for a file nobody can read (re-review R2).
  // This is the round-1 inversion — rounding an unreadable value toward RESTRICTED — surviving in
  // the one branch where being wrong is most flattering. An explicit `tools: []` is a different
  // thing and stays a real restriction; the CLI was measured granting such an agent zero tools.
  const emptyToolString = typeof rawTools === 'string' && tools.length === 0;
  // ...and the same ruling for a LIST that names something and yet yields no tool: `tools: ['']`
  // and `tools: [' ']` are unreadable in exactly the way `tools: ''` is, now that the array branch
  // trims too. `tools: []` is untouched and stays a genuine explicit restriction -- the CLI was
  // measured granting such an agent zero tools, and that is a different statement from silence.
  const emptyToolList = Array.isArray(rawTools) && rawTools.length > 0 && tools !== null && tools.length === 0;
  const malformedTools = (rawTools != null && tools === null) || emptyToolString || emptyToolList;
  // The same rule applied to the deny list, which round 1 did not do: `disallowedTools: 42` was
  // silently read as "no deny list", so the panel could not say it had failed to read something.
  const malformedDenied = rawDenied != null && deniedList === null;
  const inherits = rawTools == null || malformedTools;
  // Unparseable rounds toward unrestricted, never toward restricted. mows-agent-meta lint rejects
  // such a file, but this dashboard must not answer an unknown by inventing a limit that nothing
  // enforces — which way to round under uncertainty is the whole ruling of this task.
  const effective = inherits ? null : tools.filter(t => !denied.has(t));
  // A kind is present when at least one of its tools survives. On the inherit path the deny list is
  // the only subtraction with anything to bite on, so denying Bash and Task there does NOT make an
  // agent narrow — it leaves Write, Edit, NotebookEdit, WebFetch and the rest. That is exactly the
  // shape that rendered no warning at all in round 1 while the panel said "every tool" (review F3).
  const authorities = AUTHORITIES
    .map(a => ({ kind: a.kind, beyondList: a.beyondList,
      tools: inherits ? a.tools.filter(t => !denied.has(t)) : a.tools.filter(t => effective.includes(t)) }))
    .filter(a => a.tools.length);
  const broad = authorities.filter(a => a.beyondList).flatMap(a => a.tools);
  const m = (fm && typeof fm.mows === 'object' && !Array.isArray(fm.mows) && fm.mows) || {};
  const rawTrig = Array.isArray(m.triggers) ? m.triggers : [];
  const triggerTypes = rawTrig.map(t => (t && typeof t === 'object' && typeof t.type === 'string') ? t.type : 'unknown');
  return {
    // null, not [], while inheriting: the field is documented as the tool list, and [] reads as "no
    // tools" to any consumer that does not also read `inherits` (review F6). `.effective.length` on
    // an inheriting agent now throws instead of quietly concluding zero.
    effective,
    broad,
    narrow: inherits ? null : effective.filter(t => !broad.includes(t)),
    hasBroad: broad.length > 0,
    authorities,
    inherits,
    malformedTools,
    malformedDenied,
    // Tools whose reach this page cannot state. `mcp__*` is split out because it is the case with a
    // name: an MCP tool reaches whatever its server reaches — the network, the filesystem, a
    // production database — and nothing about that is knowable from the tool name, so `unknown` is
    // the only honest answer rather than a guess in either direction.
    //
    // These two fields exist because of the quiet-state audit: `tools: [Read, mcp__figma__x]`
    // produced a panel identical to a genuinely read-only agent's. Reporting the residue closes
    // that whole family at once — including tools that do not exist yet — rather than adding a
    // classification per tool name as each one is noticed.
    mcpTools: inherits ? null : effective.filter(t => MCP_RE.test(t)),
    unclassifiedTools: inherits ? null
      : effective.filter(t => !AUTH_TOOLS.includes(t) && !BENIGN_TOOLS.has(t) && !MCP_RE.test(t)),
    // Tool names that differ from a known tool ONLY in case. BROAD_TOOLS is case-sensitive and
    // neither mows-agent-meta nor Claude Code validates tool names, so `tools: [read, bash]` lists
    // two tools that do not exist AND silences the shell warning (review F10). Only exact-except-
    // case matches are reported, so a legitimately unfamiliar tool never produces a false alarm.
    miscasedTools: inherits ? [] : effective.filter(t =>
      !AUTH_TOOLS.includes(t) && AUTH_TOOLS.some(k => k.toLowerCase() === String(t).toLowerCase())),
    // The deny-list entries that subtract nothing, because the allow list never granted them. Named
    // so the panel can say the deny list is decoration rather than letting a reader of the agent
    // file assume it is doing safety work. Meaningless while inheriting (see above), so empty there
    // by construction.
    denyNoop: inherits ? [] : [...denied].filter(t => !tools.includes(t)),
    // The mirror of denyNoop, and the reason it matters: deny entries that removed an AUTHORITY
    // tool the allow list had granted. When an agent renders quiet only because of these, the
    // panel's most reassuring output is resting entirely on the deny list being honoured — so it
    // says so rather than presenting the silence as a property of the tool list (re-review R1).
    // The panel already went to trouble to name a deny list that does nothing; this is the case
    // where it does everything.
    denyLoadBearing: inherits ? [] : [...denied].filter(t => tools.includes(t) && AUTH_TOOLS.includes(t)),
    denied: [...denied],
    policy: {
      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,
      // Stated rather than silently ignored (review F2). `plan` is lint-accepted and would make the
      // authority list above wrong; `bypassPermissions` is refused by the linter. The panel cannot
      // verify that the CLI honours any of them, and says so rather than implying it checked.
      permissionMode: typeof fm?.permissionMode === 'string' ? fm.permissionMode : null,
      // An agent file carries TWO turn limits and nothing reconciles them: `maxTurns` in the Claude
      // namespace, which the CLI reads out of the .md itself, and `mows.budget.max_turns`, which
      // mows-agent reads with jq and passes as `--max-turns` (agents/bin/mows-agent:214). The
      // validator range-checks each and cross-checks neither, so `maxTurns: 100` beside
      // `max_turns: 5` lints clean — and the panel used to report the mows figure alone as though
      // it were the cap. Which one binds is a CLI precedence question this page cannot answer, so
      // it reports the disagreement rather than picking a winner. Found while working out what the
      // measured "declared != granted" finding implies for the panel's other frontmatter fields.
      maxTurnsDeclared: (Number.isInteger(fm?.maxTurns) && fm.maxTurns > 0) ? fm.maxTurns : null,
      turnCapDisagreement: Number.isInteger(fm?.maxTurns) && Number.isInteger(m.budget?.max_turns)
        && fm.maxTurns !== m.budget.max_turns,
      triggers: rawTrig,
      // Flattened here rather than in the view: a trigger entry is raw YAML and need not be an
      // object at all, and a view that reached into `.type` on each would print "undefined".
      triggerTypes,
      // Whether a WEBHOOK_SECRET_<NAME> is configured for this agent. Supplied by the caller
      // (lite.mjs reads the config; this module stays pure and shell-free) and deliberately a
      // BOOLEAN — the secret itself must never reach a response body. null = not determined.
      //
      // It belongs on this panel because /wh/<name> authenticates against that config key ALONE and
      // never reads the agent file: a configured secret means an HTTP POST can start this agent
      // whether or not its triggers list says so. That is a capability the declared triggers hide.
      webhookArmed: typeof opts.webhookArmed === 'boolean' ? opts.webhookArmed : null,
      // ...and the mirror of it, which round 1 disclosed in only one direction (review F11): a
      // DECLARED webhook trigger with no configured secret is inert — /wh/<name> answers 404 on the
      // same branch it uses for an unknown agent. Only asserted when the secret was actually looked
      // up (`=== false`), never inferred from a null.
      webhookDeclaredInert: opts.webhookArmed === false && triggerTypes.includes('webhook'),
    },
  };
}
