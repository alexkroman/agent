---
"@alexkroman1/aai": major
---

Replace the Workflow DevKit's durable-execution engine with one this repo owns, and take its two error classes with it.

A workflow body is now an ordinary async function of `(input, ctx)` — no `"use workflow"` directive, no compile-time transform, and no `workflowId` a WASM SWC plugin stamps onto the function. Durability is `ctx.step(name, fn)`: the engine runs a step once, journals what it returned, and answers it from the journal on every later replay. Step identity is `(name, occurrence)`, which is stable under inserting a step elsewhere and correct inside a loop, where a monotonic ordinal is the first and a bare name the second.

`@alexkroman1/aai/step-errors` now OWNS `FatalError` and `RetryableError` rather than re-exporting `@workflow/errors`'. Membership is a non-enumerable brand read by `FatalError.is` / `RetryableError.is`, never `instanceof`: a guest bundle can hold two copies of the module, and across them `instanceof` answers false — which would silently downgrade a `FatalError` to "unclassified, so retry", the exact failure the class exists to prevent and the one that costs money. The brand's VALUE is validated rather than trusted, `Symbol.for` being a registry anyone can mint from. `RetryableErrorOptions.retryAfter` no longer accepts a duration string; no call site passed one.

`ctx.sleep(until, { correlationId })` is durable suspension: the body stops, the
process is freed, and the engine re-delivers the run when the time comes — so a
wait may be days long and survives a redeploy, an idle reclaim and a crash. A
sleep's wake time is journaled on the FIRST reach, because a deadline recomputed
from the clock on every replay moves further out each time and the run never
wakes. `ctx.workflows.wake(runId, [correlationId])` cuts one short, and reports
how many waits it actually stopped rather than how many it looked at.

`ctx.waitFor<T>(token)` parks the run on somebody else's answer, with no deadline
at all: nothing but `ctx.workflows.signal(token, payload)` or a webhook at
`publicWebhookUrl(token)` ends it. It replaces the DevKit's `createHook()`, whose
token was generated body-side — which is the wrong place, since whoever hands the
URL out is a tool and cannot see the body's locals. The token is the author's now,
derived so both sides agree. A token two waits share is refused rather than
resolved arbitrarily: one signal would end whichever the store found first and the
other would wait forever.

`@alexkroman1/aai` no longer depends on `workflow` at all.

Eighteen capability epoch classifications in all, every one a `--drop`: `workflow`, `workflow-api` and `step-errors` for the signature changes above, `aai-runtime:eval` for the eval engine's own `WorkflowCtx`, and the rest collaterally — their reports name `ToolContext.workflows`, so the changed body type reaches them.
