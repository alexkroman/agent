---
"aai-evals": patch
---

Hash the starter-eval corpus in this package's cached test tasks.
`starter-expectations.test.ts` imports `EXPECTATIONS` and `checkCapabilities`
from `../../scripts/starter-eval/expectations.mjs` and asserts directly over
that data, but `inputs` globs resolve relative to the PACKAGE — so editing an
expectation replayed a cached green `aai-evals#test:coverage`, the very task the
CI coverage matrix added so these suites are gated at all. Verified the
documented way: the task hash was byte-identical across a change to the corpus
before this, and moves with it after.

Scoped to a package `turbo.json` rather than the root `globalDependencies`,
whose five entries are all files every task reads; this corpus is read by one.
