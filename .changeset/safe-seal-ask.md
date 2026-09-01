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

## The eight workflow templates are migrated

Every shipped template's body is `(input, ctx)` now, its steps are ordinary
exported functions called through `ctx.step`, and its `sleep`/`createHook` use is
`ctx.sleep`/`ctx.waitFor`. `@alexkroman1/aai` and `aai-templates` no longer depend
on `workflow` at all.

Three things the migration bought rather than merely moved:

- **A retry policy is an argument, not a property.** `fn.maxRetries = 5` became
  `ctx.step(name, fn, { maxAttempts: 6 })` at the call, which is where it
  belongs — the same function called from two sites may deserve different
  patience, and a property could not say so. `research-workflow` has exactly that
  case, its two `investigate` waves.
- **`recap-workflow`'s retention gate lost forty lines of scaffolding.** It was
  `vi.mock("workflow")` over `createHook` and `sleep`, a hand-built `Hook`
  assembled by hanging members on a real promise, and a never-resolving `sleep`
  so the two sides of a `Promise.race` could not settle in an order that decided
  the test instead of the branch. It is one `ctx.waitFor(token, { timeoutMs })`,
  so an answer is a `hooks` entry and the closed window is its absence.
- **`createWorkflowCtx` (`@alexkroman1/aai/testing`) is new**, because a body
  takes a `ctx` only an engine constructs and three templates had hand-rolled
  one. It runs the steps and records what the body asked for, so a spec can
  assert a policy that is otherwise observable nowhere.

`ctx.waitFor` takes a `timeoutMs` for the same reason, and it is a parameter
rather than a race deliberately: both `waitFor` and `sleep` suspend, and a
suspend unwinds the stack, so `Promise.race([waitFor, sleep])` stops the body
before the other side has been reached. Worse, it DIVERGES — the body returns
`undefined` and moves on, and a signal landing a second later would make the next
replay read a payload and take the answered branch. The engine closes the hook as
the window shuts, so the answer stays a fact.

`@alexkroman1/aai` no longer depends on `workflow` at all.

Eighteen capability epoch classifications in all, every one a `--drop`: `workflow`, `workflow-api` and `step-errors` for the signature changes above, `aai-runtime:eval` for the eval engine's own `WorkflowCtx`, and the rest collaterally — their reports name `ToolContext.workflows`, so the changed body type reaches them.
