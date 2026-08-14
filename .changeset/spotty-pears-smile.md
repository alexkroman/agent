---
"@alexkroman1/aai": minor
---

Add `ctx.workflows.signal(token, payload?)` — deliver an answer to a durable run
parked on `createHook({ token })`, resolving `false` when no hook holds the
token.

This is the half of the Workflow DevKit's waitpoint mechanism a voice agent
could not reach. A run that has to wait for a PERSON — an approval, a choice, a
"yes, go ahead" — parks on a hook, and the only way to feed one was the public
URL `createWebhook()` mints, which is addressed to a third party with a callback
to make rather than to the caller already on the line. `wakeUp` is not the same
thing: it ends a pending `sleep()`, where a signal carries a payload, and a body
that races a hook against a `sleep` — a decision with a deadline — needs both.

`false` is an answer rather than a failure, matching `cancel` resolving false
and `wakeUp` resolving `0`: the run has moved past its hook, finished, or was
never started.
