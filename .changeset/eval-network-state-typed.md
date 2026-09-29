---
"@alexkroman1/aai-runtime": minor
---

`evalNetwork({ state, routes })` gives routes shared state: the `state` factory's value is passed to every route as its third argument, exposed as `network.state` (typed, `EvalNetwork<State>`), and rebuilt by `reset()`, so `describeEval` hands every case and repeat fresh state from an instance too. In a `describeEval` suite given a `network`, a case's `ctx.network` is now typed as that network — no `undefined` to guard, `state` typed — and a case's own `network` must be of the suite's type.
