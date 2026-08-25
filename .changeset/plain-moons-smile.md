---
"aai-studio-server": patch
---

Answer the four remaining studio guest RPCs with the sentence a validation issue carries, not the raw blob. `studio/sync-workspace`, `studio/agent-logs`, `studio/persist-chat` and the `workspace/deploy` response all interpolated `parsed.error.message` — which for a `ZodError` is `JSON.stringify(issues, null, 2)` — so one wrong field answered with a multi-line array of `{ code, origin, path }` objects. The first three reach the coding agent as an RPC rejection it is meant to act on; the fourth is rendered verbatim into the Publish menu, where a JSON dump is the only thing the user is told about a failed publish. `errorMessage(parsed.error)` renders the same issues as one line. Follow-up to the same fix in `aai-server`'s error handler.
