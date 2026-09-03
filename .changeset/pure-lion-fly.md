---
"aai-server": patch
---

Flatten the workflow queue claim's cost curve, and time the admin-pool acquire.

The claim re-orders the whole due set before applying its limit — that ordering is what stops a busy tenant starving a quiet one — so database work per message delivered grew with how far behind the queue was: at 180,000 due it sorted 179,960 rows to return 8, costing 467ms and 13.3MB of temp spill per tick, on a pool of 15 server connections shared by the whole fleet. Three result-identical changes take that to 142ms and 3.3MB: `distinct on (slug, run_id)` becomes a group-minimum anti-join that can early-terminate, the `locked_at` OR is split into a `union all` of its two disjoint branches so the unclaimed one is an ordered index scan that stops at the limit, and the outer limit is pushed into each arm. A new index (`slug, run_id, kind, available_at, id`) makes the anti-join's probes seeks rather than scans of the busy tenant's backlog; it costs single-digit microseconds per queue write, so break-even is around 85,000 writes per tick. The idle tick — what a 1Hz sweep is doing almost always — is unchanged and halves its buffers.

Equivalence is checked against a frozen copy of the old selection, at eight widths and over 24 randomised fixtures, in a new real-Postgres suite.

Separately, `withReserved` now times the reservation every guest-called platform route takes: a wait past half a second warns and names the pool, an ordinary one logs at debug, a failed acquire warns with the wait it spent (it logged nothing at all before, because the reservation is taken outside the `try`), and a 503 carries `waitedMs` and `workMs` so a failure says whether it was pool contention or a slow statement.
