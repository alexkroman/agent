---
"@alexkroman1/aai-runtime": minor
---

Retry a failed workflow-world start, because its commonest failure is transient.

A blue-green handover boots the replacement guest while the old one drains, so
for a few seconds two guests share the app role's `APP_DB_CONNECTION_LIMIT` — a
boundary `app-db-budget.ts` states outright. What it did not say, because it is
`startWorkflowWorldIfDeclared`'s business, is what losing that race COST:
`migrateAndSubscribe` ran once, the catch logged, and the replacement then
served its entire life with NO QUEUE WORKER — while answering `/client-config`
and voice sessions normally, so nothing looked wrong and every durable run for
that agent was stranded.

Measured on a real redeploy mid-run: the replacement logged `too many
connections for role "app_…"` 300ms after listening, and a flow job that came
due 15s later sat unlocked at `attempts 0/3`, claimable, with a live guest that
was not polling. With a bounded backoff (five retries, ~62s, covering a
draining predecessor's exit) the same scenario now recovers on attempt 3 in
6.5s. Exhausting the budget still logs and returns rather than throwing — an
agent whose workflows are broken should still answer the phone.
