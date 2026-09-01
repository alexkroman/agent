---
"@alexkroman1/aai": major
---

Replace the Workflow DevKit's durable-execution engine with one this repo owns, and take its two error classes with it.

A workflow body is now an ordinary async function of `(input, ctx)` — no `"use workflow"` directive, no compile-time transform, and no `workflowId` a WASM SWC plugin stamps onto the function. Durability is `ctx.step(name, fn)`: the engine runs a step once, journals what it returned, and answers it from the journal on every later replay. Step identity is `(name, occurrence)`, which is stable under inserting a step elsewhere and correct inside a loop, where a monotonic ordinal is the first and a bare name the second.

`@alexkroman1/aai/step-errors` now OWNS `FatalError` and `RetryableError` rather than re-exporting `@workflow/errors`'. Membership is a non-enumerable brand read by `FatalError.is` / `RetryableError.is`, never `instanceof`: a guest bundle can hold two copies of the module, and across them `instanceof` answers false — which would silently downgrade a `FatalError` to "unclassified, so retry", the exact failure the class exists to prevent and the one that costs money. The brand's VALUE is validated rather than trusted, `Symbol.for` being a registry anyone can mint from. `RetryableErrorOptions.retryAfter` no longer accepts a duration string; no call site passed one.

`@alexkroman1/aai` no longer depends on `workflow` at all.

Nine capability epochs are classified as dropped: `workflow` and `step-errors` for the signature changes above, and seven collaterally, their reports naming `ToolContext.workflows` and so the changed body type.
