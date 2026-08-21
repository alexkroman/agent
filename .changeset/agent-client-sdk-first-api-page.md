---
"@alexkroman1/aai": minor
"aai-studio-server": patch
---

Calling a deployed agent is now one client, and the studio's API page is written
in it. `createAgentClient` (`@alexkroman1/aai/workflow-api`) is a superset of
`createWorkflowApiClient`: every workflow route plus `config()`, the front-door
read (`GET /client-config`) that had no client at all — so a caller stops
building two things, one of which was a `fetch` and a hand-written URL join.

Two new calls cover the streams. `follow(runId)` and `followOutput(runId)` are
async iterables — `for await (const run of agent.follow(id))` — and they hold the
two protocol rules a hand-written SSE loop gets wrong, neither of which looks
like a bug when it goes wrong: the state stream hands the client back with an
`idle` frame after its own duration cap (a run may sleep for hours, so that is a
re-open, not an ending), and one output read is bounded by the tail it saw (so the
next read has to resume from an absolute index). A stream that ends with the run
unsettled throws rather than reading as a run that finished. `watch` and
`streamOutput` still resolve the raw `Response`, which is what a caller writing
its own polling fallback needs; there is deliberately no fallback inside the
iterators. `readEventStream` is the SSE parser under them, now public — the
browser client's private copy is deleted rather than duplicated.

`WorkflowApiClientOptions.token` and `.timeoutMs` accept an explicit `undefined`,
so `token: process.env.AAI_WORKFLOW_API_TOKEN` compiles under
`exactOptionalPropertyTypes` instead of needing a `!`.

The API pane and the public page at `/studio/api/<slug>` now lead with the SDK in
every section, with `curl` and `aai workflow` one disclosure away, and each route
row names the call that makes it. An upload-carrying input renders as the
`agent.upload(...)` call and a reference to its id rather than as a placeholder
string, and the page reads the agent through the same client it documents.
