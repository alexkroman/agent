---
"@alexkroman1/aai": minor
---

Close the playback loop, fix the dead-air cover, and default preemptive generation off

Four changes to the pipeline transport, each measured on tau2-bench retail:

- **`playback_progress` (new client->server frame).** The host modelled
  playback open-loop — every forwarded chunk assumed to start playing on
  arrival at exactly 1.0x — so a client draining slower accrued a backlog it
  could not see, and then released `speech_started` over speech the caller
  had not heard. Clients that discard buffered audio on that edge lost ~35s
  per run; with the frame it is ~2s. The clock clamps UPWARD ONLY, so a client
  that never sends it behaves exactly as before. aai-ui's playback worklet
  emits one every 500ms while audio is queued.
- **Dead-air cover re-arm.** The `tool-call` branch re-armed the cover
  unconditionally, and `RestartableTimer.arm` clears-and-resets — so a chain
  of calls each returning inside the window pushed the deadline out forever
  and the cover never fired at all. Now only armed when none is pending.
- **`preemptiveGeneration` defaults to false.** Finally measured: 14
  adoptions bought a p50 0.44s head start, but 36% were poisoned after
  adoption by a tool call and restarted the turn, having burned p50 0.69s
  first. Net +8ms per caller turn for 44% of its LLM requests discarded.
- **Endpointing back to the measured 1600/3500 pair** (the 3000 trim was never
  measured alone and its own doc named the revert condition, which a run then
  showed), with `speechIdleTimeoutMs` moved 3500 -> 4000 to keep the margin.

Also: a per-turn LLM timing line so a stalled turn is attributable at all, and
a system prompt that no longer contradicts itself on repeat-asks.
