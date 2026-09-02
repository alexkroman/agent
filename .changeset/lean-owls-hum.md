---
"aai-server": patch
---

Record when a step STARTED. `StepEntry.startedAt` joins the journal, so `finishedAt - startedAt` is what the step cost.

An entry carried `attempts` and `finishedAt` and no start, so the only elapsed time derivable from a run's history was the gap between one step's finish and the next's — which is the previous step's cost plus whatever the body did between them, and is nothing at all for the first step of a run or the first after a durable wait. The park-curve numbers in `packages/aai-runtime/CLAUDE.md` came off a log line because the journal could not be asked.

An absolute instant rather than a stored duration: the difference is derivable and the instant is not, and the gap between one entry's finish and the next's start is DELIVERY latency — a different question from step cost, and the one that tells a slow step from a slow queue. The span covers the whole reach (every try and its backoff) and excludes time queued behind the step gate.

OPTIONAL, and absence means the row predates the column: the rows already stored have no start, and `0` would report a long step as instant. All four backends carry it, the conformance table pins absence in both directions (a start of `0` is kept, so an arm cannot satisfy the absence case by coercing), and `20260902000000_workflow_step_started_at.sql` adds the platform column.

No reader surfaces it yet — the public workflow API carries a run snapshot and no step history — so it is queryable from the database and nowhere else. A route and a CLI verb are the next move and are not in this change.

Also widens `journal-ddl-parity.test.ts`, which read only the migration that CREATES these tables and was therefore blind to any later ALTER — the drift it exists to catch. It now reads every migration in filename order, applies `add column` on both sides, and scopes the parse to the five tables the pairing derives. That immediately surfaced three previously uncompared platform-only objects (`workflow_runs.reconciled_at` and the two reconcile indexes), each now declared with its reason.
