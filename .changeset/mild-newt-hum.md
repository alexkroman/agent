---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
---

Tune the TTS playback path against a recorded reply: one fill target instead of two, a smaller pacer burst, a larger pacer lead, and a heard-cursor ear-lag that is no longer double-counting the client's buffer.

`PLAYBACK_JITTER_MS` is deleted. It was redundant by construction: on a turn's first render the ring buffer is empty, so the underrun branch fires before any audio exists and arms the REFILL target — every turn already waited for that number, and the separate startup target could only act by being larger. Measured, `{jitter: 0, refill: R}` renders byte-identically to `{jitter: R, refill: R}`. One `PLAYBACK_FILL_MS` (200) takes 16-208 ms off time-to-first-audio depending on link quality, with concealment unchanged at zero.

`PACER_BURST_MS` drops 200 to 100 and `CLIENT_AUDIO_LEAD_MS` rises 1000 to 1500. Together the longest link freeze the client rides out with no concealment goes 820 ms to 1453 ms, at no latency cost — time-to-first-audio is identical at every lead. What bounds the lead is bandwidth rather than correctness: a mid-reply barge-in discards ~1.3 s of pushed speech instead of ~0.85 s.

`HEARD_AUDIO_LAG_MS` drops 750 to 150. It is applied on top of the playback clock, whose `endsAtMs` already tracks the client's unplayed backlog, so sizing it against the buffer depth double-counts it — which both its old derivation (the deleted fill target plus a network hop) and a first attempt at a new one (`CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2`) did. Measured against the audio the ear actually received, the old value left the heard cursor ~694 ms early on a typical link, roughly ten words, which pushed toward the repetition `buildTailResumePrompt` exists to prevent. What is left for the term is the one-way network hop.

`PIPELINE_PLAYBACK_GRACE_MS` is unchanged at 750, now with the measurement recorded: barge-in requires 15-138 ms of grace depending on the link, and does not scale with the pacer's lead.
