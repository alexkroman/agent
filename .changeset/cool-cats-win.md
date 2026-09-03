---
"@alexkroman1/aai-runtime": major
"aai-server": major
---

Bound a durable run's journal growth, and answer the contended step read by key.

A live run's journal could grow without limit. Retention only ever bounded the POPULATION — `sweep_terminal_workflow_runs()` deletes terminal runs after 30 days — and a live run is not eligible for it at any size, nor can its journal be truncated, because replay answers every settled key from it. The cost is O(N) per delivery and O(N squared) across a run, since every walk reads the whole journal, so a long run got monotonically slower at doing the next step and eventually became undeliverable with nothing said. `workflow-journal-bound.ts` now warns at 8,000 journaled steps naming the count and the ceiling, and refuses at 10,000 with a message naming the remedy, before a body runs.

BREAKING: `JournalStore` gains a required `readStep(runId, key)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers ONE settled step by key, or undefined when it has not settled. `settledSince` — the re-read on the contended path, reached when `claimAttempt` says another walk touched a key — used to read the whole journal and keep one entry, an O(N) scan for an O(1) question in exactly the runs where N is largest. Both shipped databases key the step table on (run_id, key), so it is an index seek and needs no migration.
