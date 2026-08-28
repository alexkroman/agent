---
"@alexkroman1/aai-runtime": patch
---

Complete the workflow HTTP API's stated auth posture, and pin it on the routes that
matter. The module doc reasoned only about the COST of failing open — which is the one
exposure the platform's per-IP limits already bound — and said nothing about the two
that nothing bounds: the unkeyed arm of `GET /workflows/runs`, which converts knowing a
slug into knowing run ids, and `DELETE /runs/:id` / `POST /runs/:id/wake`, which change
a run somebody else started and rest on those ids being unguessable. The posture and the
argument now live in `workflow-api-auth.ts`, and the token gate is covered on the run
listing, cancel and wake rather than only on `GET /workflows` — a check that moved
inside a route would have left the destructive verbs open with the suite green. No
behaviour change: open-by-default is unchanged, and closing the enumeration arm
independently is recorded as the open question rather than taken.

Also corrects `WorkflowApiOptions.engine`'s doc, which still argued that an undefined
client has two causes and that naming one would be "a confident false statement".
`buildWorkflowClient` returns undefined on exactly one condition, and the message it
answers with was corrected to say so; this doc was the holdout arguing that was a
mistake.
