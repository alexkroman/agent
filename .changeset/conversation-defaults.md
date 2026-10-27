---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

New pipeline defaults, measured on tau2-bench retail: `minTurnSilenceMs` 1600 →
800, `interruption.continuationWindowMs` 2500 → 3500, and `assemblyAIStt` now
sends `vad_threshold` 0.02 (`DEFAULT_VAD_THRESHOLD`; it sent nothing before, so
the service's 0.2 applied). The 800 ms floor relies on continuation re-joining a
turn split mid-sentence — an agent that sets `continuationWindowMs: 0` should
also set `minTurnSilenceMs: 1600`. At 0.02 a caller voice the service gate had
dropped entirely is heard; watch background-speech leakage in noisy rooms.
