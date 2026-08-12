---
"@alexkroman1/aai": minor
---

Prove workflow durability, and close two gaps it exposed.

`startTool` takes an optional `inputSchema` + `input` pair, for a run whose input
comes from the session rather than from the caller — a workflow cannot read
`ctx.state`, so that snapshot is built by code rather than typed by an LLM.
`ctx.workflows.recent(def)` is the operator's read where `find` is the agent's:
runs of one workflow, newest first, whatever key they carry, reachable over HTTP as
`GET /workflows/runs?workflow=X` with no `&key=`.

Both came out of a restart suite that kills the host after every journaled step and
asserts each step body ran exactly once — run against a real Postgres journal as
well as the in-memory one, since only the former can see an encoding bug in the
journal. Running it also found a notice leak: `alter table … add column if not
exists` raises SQLSTATE `42701`, which the driver's notice filter did not carry, so
every engine after the first logged one line per boot.

`dispatch-center` is now the worked example of a voice agent starting durable work
from a tool, and the studio's Settings pane shows what a project's workflows have
been doing.
