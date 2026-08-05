---
---

Drive every randomized interleaving harness with fast-check instead of a
hand-rolled PRNG: the four `aai-ui/fuzz-*` suites, the worklet stress tests, the
studio concurrency suite, and the pipeline transport fuzz. Six copies of
mulberry32/xorshift and their `for (seed = 1; seed <= N)` loops are gone.

The payoff is shrinking. A failure now reports the smallest input that still
breaks the invariant, so a counterexample reads as a scenario instead of a
transcript — reverting the drain-stop turn-id guard shrinks to four operations,
and the scheduler-driven harnesses print the interleaving as a `schedulerFor()`
template that pastes into a deterministic regression test. Each migration was
checked against the bug its harness was originally written for.

Two measurements came out of the migration. The studio suite's "archive only past
the attempt cap" invariant was vacuous — zero archives over 200 seeds and over
100 fast-check runs — so that boundary now has its own targeted property. And
reverting the `capLlm` history fix leaves the pipeline fuzz green either way,
confirming the deterministic spec in `pipeline-history.test.ts` is what guards
it.

Tests and one devDependency only, so this note is informational.
