---
"@alexkroman1/aai": minor
---

Four SDK gaps the templates had been working around.

`ToolContext.deadlineAt` — this call's own deadline, so a tool that can answer partially budgets under it instead of being cut off with `Tool "x" timed out after 30000ms`. Per call, because a host may pass its own `timeoutMs`.

`stepGenerateJson` now constrains the request as well as validating the reply: the schema is rendered as JSON Schema and appended to `system`, so a prompt can no longer ask for a field the schema has since renamed. Stays zero-zod — Zod v4 and ArkType both expose an instance converter.

`SubagentDef.schema` — the shape a subagent's final message must have. The runtime parses it and sends a mis-shaped answer back on the same retry budget a guardrail uses, and `ctx.delegate` answers with the parsed `object` through an overload, so a subagent without a schema is untouched.

Plus a documentation fix: `useAgentState`'s projection overload cannot be used when the slot's module is expensive to import, which is a fact about the static import graph rather than about the call.
