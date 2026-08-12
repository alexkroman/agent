---
"@alexkroman1/aai": minor
---

Integrate workflows with agents.

- **Start a run by passing the workflow, not its name.** `ctx.workflows.start(digest, input)` types the input against the workflow's own schema and makes a misspelling a compile error; `agent({ workflows })` stays the single source of the journaled name (the def is resolved by identity). The string overload remains for a name that is genuinely data.
- **Correlate a run to its caller.** `start(def, input, { key })` plus `find(def, key)`, so a durable run stays reachable after the session that started it is gone — previously the only handle was a `runId` in per-session state that is swept shortly after a hangup.
- **`startTool(def, { description })`** builds the tool that starts a run, deriving its `inputSchema` from the workflow and defaulting the key to the session.
- **The `workflow_status` builtin** lets a voice agent answer "is it ready yet?" with no hand-written plumbing, scoped to the calling session by construction.
- **`cancel(runId)`** on `ctx.workflows` and the browser client, plus `DELETE /workflows/runs/:id`.
- **`WorkflowRunSnapshot` is discriminated on `status`**, so a completed run narrows to a typed `output` with no cast, and `isTerminal` is a type guard covering the new `cancelled` status.
- **A step result that cannot survive the journal is refused on its first execution**, naming the property path, instead of silently changing on a later replay; a run whose step sequence changed between replays is reported.
