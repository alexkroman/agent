---
"@alexkroman1/aai": minor
---

Add four host-side built-in tools and enable them by default: `think` (a
private no-op reasoning scratchpad, per the spec Anthropic published for its
tau-bench evaluation), `remember`/`recall` (session-scoped notes in KV, so
confirmed IDs/codes/dates survive noisy voice transcripts), and `calculate`
(a safe recursive-descent arithmetic evaluator — no `eval`, no code
execution). When an agent does not set `builtinTools`, the new
`DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) are
enabled; setting `builtinTools` explicitly — including `[]` — overrides the
default. The network built-ins (`web_search`, `visit_webpage`, `fetch_json`)
and `run_code` remain opt-in.

Host-mode (relayed) sessions now expose built-in tool schemas and guidance
alongside the client-supplied tools, executing built-ins host-side instead of
relaying them — so a tau2-style harness session gets `think`/`calculate`/notes
for free. Name collisions resolve in favor of the custom or relayed tool: the
built-in is dropped from both dispatch and schemas.
