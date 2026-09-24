---
summary: >-
  The integration-tier property tests: the S2S model-based fuzz, the pipeline
  fuzz, and the history-rollback oracle
read_when: >-
  adding to or debugging a test under `src/integration/`
---

# aai-runtime integration tests

## S2S property test

`s2s-fuzz.integration.test.ts` (with `_s2s-fuzz-model.ts`,
`_s2s-fuzz-harness.ts`, `_s2s-fuzz-commands.ts`) is a fast-check property test
of the S2S stack, keyless. The spec's and `_s2s-fuzz-model.ts`'s module docs
carry the design: the SOCKET is the only fake, and no TIMER is used.

- **Model-based COMMANDS**: legality lives in each command's `check()` against a
  model of the provider state machine, so a counterexample contains only
  commands that ran.
- **Three properties, differentiated by `faultBudget`** (0 / 2 / 3): turns,
  reconnects, retirement. Do not merge them — one budget cannot serve both
  ends.
- **Every exemption increments a `skip:<why>` counter, and floors are on the
  CHECKED counts** — the exemptions are broad enough to silence the oracle
  entirely. `S2S_FUZZ_COVERAGE=1` prints the table. A resumed session inherits
  the dead socket's unanswered tool calls; the tool-answer oracle rests on that.
- **The fakes' fidelity is where false findings come from.** The real
  `executeTool` settles promptly on abort (including an already-aborted signal)
  and always RESOLVES, with `serializeToolFailure(...)` on failure. Check the
  real collaborator's contract before believing a finding.

## History rollback oracle

`pipeline-history-rollback.integration.test.ts` is a fast-check property over
generated fill scripts, driving both `pipeline-history.ts`'s own door and the
real one (`persistBargeIn` with a `syntheticPrompt`), against a snapshot of
both views taken before the push. The rule it holds is in
[`../transports/CLAUDE.md`](../transports/CLAUDE.md), "A rollback must undo the
eviction its push caused". `session-history-replay-equivalence.test.ts`
compares TAILS for an unrelated reason (the two sides trim different sequences),
and its `liveTrims` floor stands.
