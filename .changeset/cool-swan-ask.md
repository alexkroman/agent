---
"@alexkroman1/aai": minor
---

Reject unknown fields in `agent()` instead of silently dropping them, and type `ctx.env` as `Partial` so an undeclared credential is `string | undefined`. Adds `requireEnv(ctx, name)`, the `ToolContext` twin of `requireStepEnv`.
