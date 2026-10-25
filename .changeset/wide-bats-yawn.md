---
"@alexkroman1/aai-cli": minor
"@alexkroman1/aai-runtime": minor
---

aai start --workers N serves one build from N processes: client-affinity routing (no database required; DATABASE_URL adds crash survival), primary-owned lifecycle with drain (--drain-timeout), SIGHUP rolling restart and per-worker admission (--max-calls-per-worker). Runtime: per-frame hot paths memoized, provider frames sent in one TLS write per tick, model-provider connections kept alive 30 s across turns, pooled event-id randomness and a TTS audio fast path.
