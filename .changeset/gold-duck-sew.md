---
"@alexkroman1/aai": minor
---

Publish the workflow HTTP API's client as `@alexkroman1/aai/workflow-api`.

`createWorkflowApiClient({ baseUrl, token?, timeoutMs? })` is one implementation of
all ten routes — `streamOutput` and `wake` included — that the browser client,
`aai workflow` and the studio's Workflows card had each written a different subset
of — disagreeing on whether a 404 from `GET /runs/:id` is an answer, whether an
absent `limit` is encoded, and whether the agent's own `{ error }` sentence is
unwrapped or reported still wrapped in its JSON.
`timeoutMs` is new to all three: a per-request deadline that exempts the event
stream and adds a waiting read's own `wait` budget on top of itself.

`WORKFLOW_API_PREFIX` is declared beside the client so the server, the `aai dev`
proxy table and the client all resolve one literal; `@alexkroman1/aai/runtime`
re-exports it unchanged.

`createWorkflowApi` in `@alexkroman1/aai-ui` is now a wrapper that supplies the
page's own base URL, and its public surface is unchanged — `WorkflowApi` is
re-exported from the SDK rather than declared, so a client from either factory is
the same type (`aai-ui:workflow` epoch 5, epochs 1-4 retained).

Two message changes: a failure whose body is not the API's `{ error }` shape is now
labelled (`Workflow API 502: <html>` rather than `502: <html>`), and
`aai workflow show` reports `No run <id>` for a 404 instead of the agent's
sentence, which cannot distinguish an unknown id from an agent that serves no
workflow API.
