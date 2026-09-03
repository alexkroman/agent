---
"@alexkroman1/aai-runtime": major
"aai-server": major
---

Answer an ELAPSED durable wait from the walk's own snapshot, so a polling run's journal traffic stops being quadratic.

A replay answered a settled `ctx.step` from the one `readSteps` it takes at the top of a walk, and round-tripped `claimSleep` for every elapsed `ctx.sleep` it walked past — an unconditional call whose answer was almost always "that finished several deliveries ago". A body that polls mints a new wait key per iteration, so delivery N re-claimed N-1 finished waits before doing any work. Measured on a deployed 34-segment transcription run: journal POSTs rose +1 per delivery, monotonically, across 69 consecutive deliveries — 2,675 in 25 minutes, the gap between deliveries growing 11s to 37s in step with the count, and the run never completed. Every call succeeded, so the only symptom was a run getting slower.

BREAKING: `JournalStore` gains a required `readSleeps(runId)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers every durable wait of a run, ordered by key, as a `SleepEntry` (a `SleepRecord` plus its key). Both shipped databases key the sleeps table on (run_id, key), so it is a range scan already in that order and needs no migration. The engine issues it beside `readSteps`, concurrently, and hands it down as `ReplayOptions.sleeps`.

The snapshot may only answer a wait it already HOLDS and that is over by a monotonic test — woken, or a deadline already past. `claimSleep` is a claim rather than a read, so a miss must still create the record, and a future-dated unwoken wait must still round-trip in case a wake landed since. A stale snapshot can therefore only ever cost a round trip it did not need.
