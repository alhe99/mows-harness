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
const asList = v => Array.isArray(v) ? v.map(String)
  : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean)
  : null;

export function agentCapability(fm, opts = {}) {
  const rawTools = fm?.tools, rawDenied = fm?.disallowedTools;
  const deniedList = asList(rawDenied);
  const tools = asList(rawTools), denied = new Set(deniedList || []);
  // A Claude Code file-based subagent with NO `tools:` key inherits every tool the main thread has
  // — including Bash. Reporting that as `effective: []` ("Tools: none") would invert the truth on
  // the one shape where being wrong is worst: the file that looks most restricted is the least.
  const malformedTools = rawTools != null && tools === null;
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
    denied: [...denied],
    policy: {
      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,
      // Stated rather than silently ignored (review F2). `plan` is lint-accepted and would make the
      // authority list above wrong; `bypassPermissions` is refused by the linter. The panel cannot
      // verify that the CLI honours any of them, and says so rather than implying it checked.
      permissionMode: typeof fm?.permissionMode === 'string' ? fm.permissionMode : null,
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
