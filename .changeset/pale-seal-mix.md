---
"@alexkroman1/aai": minor
---

Add `stepInfo()` to `@alexkroman1/aai/step`: which step a body is running as, which ATTEMPT of it, the ceiling that attempt is counted against, and whether it is the last.

The engine already tracked the number — it is where a `report()` line's `(attempt N)` suffix comes from — and nothing else could read it, so the one decision a retry policy cannot make for an author was unavailable: degrade rather than fail. A smaller model on the final try beats a failed run, and only the body knows what cheaper means for its own work.

It is the Workflow DevKit's `getStepMetadata()` with two differences. It answers `undefined` outside a step rather than throwing, because an exported step is also an ordinary async function and every workflow template's tests call one directly. And it carries `maxAttempts`, without which `isLastAttempt` is a number the body restates from the `ctx.step` call site — two literals in two files whose disagreement makes a step degrade early on every run and still return an answer.

`stubStepInfo` (`@alexkroman1/aai/testing`) is how a spec reaches that branch at all; it derives `isLastAttempt` from the two numbers rather than accepting it, so a test cannot assert a body against attempt 1 of 3 calling itself the last.
