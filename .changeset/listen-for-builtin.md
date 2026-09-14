---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`listen_for` — the recognizer hint as a builtin tool, on by DEFAULT.

**`ctx.steerRecognizer` could only be reached by a tool the author wrote, and the agents that need it most write none.** The capability biases the recognizer toward words a lookup just returned; the case it exists for is a caller's NAME, which on tau2-bench retail collapsed repeatedly and fatally ("Yusuf" → "Yuta" → "Yufus", three failed lookups and a transfer) while order ids survived 41 renderings with one digit substitution. But a benchmark agent — and any agent running in HOST MODE, where the client supplies the tool schemas and tool calls are relayed back to it — has no host-side tool body to call it from. The capability was unreachable for exactly the deployments whose failures motivated it.

`listen_for` closes that: a builtin whose `execute` calls `ctx.steerRecognizer`, so the MODEL asks for the hint at the moment it has the fact. Builtins are merged with a host's own tool schemas, so a relayed-tool deployment gets it too.

**It is the first entry in `DEFAULT_BUILTIN_TOOLS`, which was empty, and that is the exception that states the rule.** Every other builtin gives the agent something to DO, which is a decision about the product and so the author's; this one changes only what the agent HEARS, and it is worth most precisely where nobody thought to switch it on.

**Scoped to the modes where it can work.** Text mode has no audio and S2S runs recognition service-side behind a socket exposing no such control, so the DEFAULT is filtered for both — offering it there would spend the schema's tokens advertising a capability the session does not have, and invite a call that can only answer "this session's recognizer cannot be steered". An agent that NAMES it still gets it in any mode, and the tool reports that failure honestly rather than claiming success.

**Naming any builtin still REPLACES the default list** — `builtinTools` is a list, not a patch, so `["think"]` means think and nothing else. Not special-cased: a tool that could not be switched off would be worse than one that has to be re-named. Write `["think", "listen_for"]` to keep it.

The live wire path is verified against the real service: a mid-stream `UpdateConfiguration` carrying the merged list (session terms first, then the deployment's) is accepted with no error and no disconnect. The tool's own behaviour is A/B verified — defeating the `ctx.steerRecognizer` call fails exactly the two specs that describe it.

`aai:agent` is epoch 9 and `aai:testing` epoch 8, both RETAINING their predecessor: a union gaining a member is a widening for everyone who passes one (only code that EXHAUSTS it narrows, which an agent declaration cannot do), and the testing helpers supply the new `ToolContext` field themselves — which is what keeps an epoch-8 spec compiling while a hand-built context literal, as ever, does not.
