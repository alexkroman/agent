---
"@alexkroman1/aai": minor
---

Pipeline voice UX: stream interim user transcripts to the client (user_transcript_partial) with speech_started/speech_stopped edges, resume replies after false interruptions (falseInterruptionTimeoutMs), and expose pipeline tuning knobs on agent() — minBargeInWords, interruptionMinDurationMs, endpointSettleMs, completeSettleMs, holdPhrase. LiveKit-parity default changes: completeSettleMs default 600→500 ms, Deepgram endpointing default 300→100 ms (now configurable via deepgram({ endpointing })).
