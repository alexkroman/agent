---
"@alexkroman1/aai": minor
---

Durable runs gain two capabilities the Workflow DevKit already had and this SDK did not expose, plus a gateway fix.

`ctx.workflows.wakeUp(runId, options?)` interrupts a run's pending `sleep()` calls and reports how many it ended, so "send it now" stops being the same button as `cancel`. `ctx.workflows.stream(runId, options?)` reads what a run has WRITTEN through `getWritable()` — the only way a long run can report progress, since a snapshot carries a status and, once terminal, an output, and nothing in between. Both are served over HTTP too (`POST /workflows/runs/:id/wake`, `GET /workflows/runs/:id/stream`) and reachable from a page through `api.wake()` / `api.streamOutput()`; the platform already proxies both verbs, so no deployment change is needed. `research-desk` is the worked example for each.

`createStubWorkflows()` joins `@alexkroman1/aai/testing`: a complete `ctx.workflows` whose unstubbed methods reject by name. A hand-written stub of an eight-method client is a type assertion, which keeps compiling when the client gains a method and leaves it missing at runtime — which is exactly what these two additions surfaced in two shipped templates.

The AssemblyAI LLM Gateway's Gemini tool-schema repair is now `transformParams` middleware instead of a `fetch` wrapper. It used to parse and re-serialize every request body containing `"tools"` — the whole conversation, on every step of every turn — to delete two keywords from the tool schemas near the end of it. Middleware is handed those schemas as structured parameters before anything is serialized. The gateway's response-side repairs stay in the `fetch` wrapper, where bytes are genuinely the only place to catch them.
