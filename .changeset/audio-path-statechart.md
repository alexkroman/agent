---
"@alexkroman1/aai-ui": patch
---

The browser session's audio path — the mic grant, the worklets, and the `VoiceIO` they produce — is a statechart (`session-core-audio-state.ts`) rather than a latch, an epoch counter and two buffers spread across `ConnState`.

`audioSetupInFlight` was a dedup guard, and dedup is a state: it is `starting` now, so a repeated `config` frame mid-grant is declined by the position rather than by a flag whose owner had to be tracked ("only the init that still owns the flag may clear it"). `conn.generation` is gone with it — four `bump()` sites and four `isCurrent(gen)` reads, every bump sitting immediately behind a teardown that had just cleared the latch and could not stop the work it guarded. A stopped `invoke` can.

One fix falls out that the counter could not express: two bring-ups inside a single connection shared a generation, so the outgoing `VoiceIO`'s `onError` could tear down the replacement that had just taken its slot. Progress and failure reports carry the instance that fired them now.

A microphone granted after its bring-up was abandoned is still released — cancelling an actor hides the resolution, it does not close the device — and that check now lives once, in the producer, instead of at four consumer sites.

No public API changed.
