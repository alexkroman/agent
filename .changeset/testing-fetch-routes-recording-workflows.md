---
"@alexkroman1/aai": minor
---

Test helpers for agents whose tools call services and start workflows:

- `installFetchRoutes(routes, { unmatched, passThrough, stepFetch })` on `@alexkroman1/aai/testing/vitest` (and `stubFetchRoutes` on `@alexkroman1/aai/testing`) routes the global `fetch` and a step's `stepFetch` through one table keyed by host, `*.wildcard` or URL prefix with an optional method (`"POST supabase.test"`), and records every request with its URL and JSON body parsed. An unmatched request throws by default.
- `installStubClientInbox()` on `@alexkroman1/aai/testing/vitest`: `stubClientInbox` restored when the test ends.
- `createRecordingWorkflows({ workflows, runs })` on `@alexkroman1/aai/testing`: a `ctx.workflows` that records every start and runs nothing, with `started(name)`, `cancelled` and seedable runs for `find`/`get`/`recent`. Pass it to `describeEval` as `workflows: () => createRecordingWorkflows({ workflows: agentDef.workflows })` and read it back as `ctx.workflowClient`.
- `stubSpeech` no longer needs `ASSEMBLYAI_API_KEY` in the env; `requireApiKey: true` restores the refusal.
- A stub answer of `{ status: 204 }` (or 205/304) no longer throws while building its `Response`.
