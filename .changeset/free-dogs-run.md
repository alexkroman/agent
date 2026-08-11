---
"@alexkroman1/aai": minor
---

Workflow apps: static pages, a workflow HTTP API, and a studio mode for building them.

An agent can now be a web app rather than a conversation. `agent({ page: "static" })` declares that its front door is a page: both voice surfaces (`/websocket` and `/phone`) are refused rather than left listening — `/websocket` is completed and then declined with a protocol error naming the reason, so a voice client that dials one sees why instead of entering its reconnect backoff. This is orthogonal to declaring workflows — a voice agent can still start a run from a tool and answer its turn in the same breath.

Workflows are now reachable over HTTP, which closes the gap that made them session-only: `GET /workflows`, `POST /workflows/runs`, `GET /workflows/runs/:id` and `POST /workflows/blobs`, served by `createServer` so `aai dev`, a self-hosted server and every deployed agent expose them identically. A script, a cron job or a webhook relay can start and poll a run without the page. The routes are public like the rest of an agent's page; set `AAI_WORKFLOW_API_TOKEN` in the agent env to require it as a bearer on all of them.

`/workflows/blobs` exists because bytes may not travel in the journal — a run's input and every step output are re-read on each replay — so a page uploads separately and passes the id, and the run reads it with the new `ctx.blob(id)` and drops it with `ctx.releaseBlob(id)`. Uploads nothing ever started are swept on age.

In the browser, `@alexkroman1/aai-ui` gains `page()` — the `client()` twin that mounts React and the theme with no session, no audio graph and no socket — plus `createWorkflowApi()` and `useWorkflowRun()`. `@alexkroman1/aai/testing` gains `createWorkflowContext()` for testing a workflow's `run` the way `createToolContext()` tests a tool's `execute`.

The `transcription-desk` template is now the worked example of the whole shape: a static upload page that decodes and resamples a recording in the browser, slices it into 60-second chunks (the Sync API's ceiling is 120), and a workflow that transcribes each chunk as its own journaled step — so a run that dies on chunk 27 resumes and replays the first 26 for free.
