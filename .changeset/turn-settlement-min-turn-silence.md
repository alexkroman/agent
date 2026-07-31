---
"@alexkroman1/aai": minor
---

Remove the pipeline transport's endpoint-settlement layer (`endpointSettleMs` / `completeSettleMs` and the host-side settler) — every STT final now commits a turn immediately. End-of-turn detection moves into the STT provider: the AssemblyAI opener always sets `min_turn_silence` (default 1500 ms, override via `assemblyAI({ minTurnSilenceMs })`), and Deepgram's default `endpointing` rises from 100 ms to the matching 1500 ms.
