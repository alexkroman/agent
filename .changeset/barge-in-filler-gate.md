---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Fix dead-air filler opening the barge-in gate, and assemble spelled identifiers in code.

Filler audio drove the playback clock and `turns.markSpoke()` exactly as real
speech did, so a caller's "are you still there?" counted as interrupting a
reply and the abort discarded the reply being generated behind it — the cover
causing the silence it exists to cover. Measured on a 114-task tau2-bench
retail run: 435 barge-ins and 75 aborted turns discarding 553s of completed
work, 48 of them losing over 5s each and the worst 40.6s.

- `HeardTracker.spokeRecordable()` — a turn that has played only filler is no
  longer spoken over, which is the invariant `pipeline-transport.ts` already
  stated for `spoke()`: "a turn that has not spoken cannot be spoken over."
- Dead-air cover is armed on the `tool-call` part at `DEAD_AIR_TOOL_COVER_MS`
  (1200ms) rather than 5000ms from turn open. 113 of 123 firings on that run
  were the turn-open window at exactly 5000ms — the right turns, too late on
  every one. Only safe because of the change above, and the constant says so.
- `assembleSpelledRuns()` assembles spoken spelling runs (`"M, E, I,
  underscore, K…"` → `mei_kovacs`) for the model's transcript copy; the
  client's and history's stay verbatim. Previously asked of the model in
  prose, which mis-assembled often enough to be the largest single failure
  source — 22 of 57 failed calls never authenticated, every one with the
  correct identifier already in the caller's own words.
- `DEFAULT_SYSTEM_PROMPT`: the `PROMPT_ROLE` carve-out now names the TOOLS
  recovery ladder alongside LISTENING and SPEAKING — it pointed at a method in
  a section it did not protect — and TOOLS' "retry once" is scoped to
  non-lookup errors, where it contradicted the four-step ladder four lines
  above it. `aai:defaults` is epoch 2 with epoch 1 retained.
