---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
---

transcription-workflow: measure the upload's byte rate as an AVERAGE, and give the poll floor a comparison that means something.

The streaming flow's adaptive sleep took its rate from two adjacent polls. The store publishes bytes an `UPLOAD_PART_BYTES` window at a time, so that difference is bimodal — zero (read as a stall, giving back the flat ceiling) or one whole 8 MiB window (an instantaneous burst tens of times the true average, collapsing the sleep to its floor) — and never a throughput. It now measures against the run's FIRST poll, which is also what removes a placement bug: the `previous = at` assignment sat after the sleep, so the `continue` taken on a batch of ready segments skipped it and the next rate was computed against a pre-batch view.

`MIN_POLL_INTERVAL_MS` was 250ms and therefore dead: a durable sleep's deadline is computed before its journal write is issued and tested after that write returns, so at the measured 164-796ms of journal latency a 250ms sleep had already expired and did not sleep at all. It is 1000ms, and its doc now compares against the round trip of the machinery that implements the sleep rather than against a segment's transcription latency. Two more corrections in the same file: `MAX_IDLE_POLLS` is 20-40 minutes of silence rather than the five its doc claimed (a poll costs a delivery, not an interval), and an unreachable `remaining <= 0` arm is gone — the clamp below it already answered the floor for every input.
