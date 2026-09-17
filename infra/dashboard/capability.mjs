// What an agent can EFFECTIVELY do, derived from its frontmatter — never the deny list as
// written (spec D5, §5). An agent with Bash can write any file its OS account can reach no
// matter what disallowedTools says, so a panel that computed "read-only" from the deny list
// would mislead precisely when it matters most: harness-reviewer denies Write, Edit, WebFetch
// and NotebookEdit and not one of those four is in its tools list, so the deny list removes
// nothing at all while looking like the whole safety story.
//
// This lives in its own module rather than inside lite.mjs so scripts/capability-check.mjs can
// exercise THIS function instead of a copy of it — importing lite.mjs starts an HTTP listener.
// Same split, and the same reason, as infra/dashboard/chat-stream.mjs.
//
// BROAD_TOOLS mirrors mows-agent-meta's WRITE_CAPABLE_TOOLS exactly (agents/bin/mows-agent-meta
// is the authority on what a frontmatter field means). A shell writes through redirection; Task
// spawns a subagent whose own tool list the parent's disallowedTools does not reach. Keep the two
// sets identical — a tool that is write-capable for the linter but not for this panel would make
// the dashboard disagree with the gate that admits the file.
export const BROAD_TOOLS = new Set(['Bash', 'Task']);

// null means "the key is present but is not a tool list" — a state that must NOT collapse into
// the empty list, because an empty list reads as "no tools" and unparseable input is not that.
const asList = v => Array.isArray(v) ? v.map(String)
  : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean)
  : null;

export function agentCapability(fm, opts = {}) {
  const rawTools = fm?.tools;
  const tools = asList(rawTools), denied = new Set(asList(fm?.disallowedTools) || []);
  // A Claude Code file-based subagent with NO `tools:` key inherits every tool the main thread
  // has — including Bash. Reporting that as `effective: []` ("Tools: none") would invert the
  // truth on the one shape where being wrong is worst: the file that looks most restricted is
  // the least. `inherits` is what stops the panel from making that claim.
  const malformedTools = rawTools != null && tools === null;
  const inherits = rawTools == null || malformedTools;
  // Unparseable is treated as unrestricted, never as restricted. mows-agent-meta lint rejects
  // such a file, but this dashboard must not answer an unknown by inventing a limit that nothing
  // enforces — which way to round under uncertainty is the whole ruling of this task.
  const effective = inherits ? [] : tools.filter(t => !denied.has(t));
  // While inheriting, the deny list is the only subtraction with anything to bite on, so Bash and
  // Task are present unless it names them.
  const broad = inherits ? [...BROAD_TOOLS].filter(t => !denied.has(t))
                         : effective.filter(t => BROAD_TOOLS.has(t));
  const m = (fm && typeof fm.mows === 'object' && !Array.isArray(fm.mows) && fm.mows) || {};
  const rawTrig = Array.isArray(m.triggers) ? m.triggers : [];
  return {
    effective,
    broad,
    narrow: inherits ? [] : effective.filter(t => !BROAD_TOOLS.has(t)),
    hasBroad: broad.length > 0,
    inherits,
    malformedTools,
    // The deny-list entries that subtract nothing, because the allow list never granted them.
    // Named so the panel can say the deny list is decoration rather than letting a reader of the
    // agent file assume it is doing safety work. Meaningless while inheriting (see above), so it
    // is empty in that case by construction.
    denyNoop: inherits ? [] : [...denied].filter(t => !tools.includes(t)),
    denied: [...denied],
    policy: {
      profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,
      triggers: rawTrig,
      // Flattened here rather than in the view: a trigger entry is raw YAML and need not be an
      // object at all, and a view that reached into `.type` on each would print "undefined".
      triggerTypes: rawTrig.map(t => (t && typeof t === 'object' && typeof t.type === 'string') ? t.type : 'unknown'),
      // Whether a WEBHOOK_SECRET_<NAME> is configured for this agent. Supplied by the caller
      // (lite.mjs reads the config; this module stays pure and shell-free) and deliberately a
      // BOOLEAN — the secret itself must never reach a response body. null = not determined.
      //
      // It belongs on this panel because /wh/<name> authenticates against that config key ALONE
      // and never reads the agent file: a configured secret means an HTTP POST can start this
      // agent whether or not its triggers list says so. That is a capability the declared
      // triggers hide, which is exactly the class of thing this panel exists to surface.
      webhookArmed: typeof opts.webhookArmed === 'boolean' ? opts.webhookArmed : null,
    },
  };
}
