---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
---

Collapse the playback worklet's two fill targets into one, lower the pacer burst, and derive the heard-cursor ear-lag from the pacer.

PLAYBACK_JITTER_MS is deleted: it was redundant by construction. On a turn's first render the ring buffer is empty, so the underrun branch fires before any audio exists and arms the REFILL target — every turn already waited for that number, and the separate startup target could only act by being larger. Measured on a recorded AssemblyAI reply, {jitter: 0, refill: R} renders byte-identically to {jitter: R, refill: R}. Collapsing to one PLAYBACK_FILL_MS (200) takes 16-208 ms off time-to-first-audio depending on link quality, with concealment unchanged at zero.

PACER_BURST_MS drops 200 to 100. The burst is spent out of the client's cushion one-for-one (the longest absorbed link freeze goes 820 ms to 914 ms) and buys nothing back on the audio side, and the wakeup rate it was sized against was ~4x the measured one.

HEARD_AUDIO_LAG_MS is now CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2 instead of a literal 750 decomposed from the deleted constant. The client's buffer depth tracks the pacer's lead, not the worklet's fill target, so the two can no longer be tuned apart — the old value under-subtracted by ~130 ms, which is the direction that records words the caller never heard.
