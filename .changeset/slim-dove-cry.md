---
"@alexkroman1/aai-cli": patch
---

Move the vitest launcher `aai test`, `aai eval` and `aai build`'s pre-build gate share out of `test.ts` into `_vitest-runner.ts` — binary resolution, which spec files a run covers, which it does not, and the unrun-spec notice. The two commands are disjoint by construction (a positional argument to `vitest run` is a substring filter, not an include glob), and an import edge from `eval.ts` into the file named after the other command was the one thing that could quietly grow the coupling that design prevents; each tier's filenames now stay with the command that owns them, `TEST_FILES` beside `EVAL_FILES`. Internal module boundaries only — no command, result shape, CLI argument or published export changed.
