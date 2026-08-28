---
"@alexkroman1/aai-runtime": patch
---

AssemblyAI streaming TTS: keep the final segment's word timings, and recognize a sentence closed by a curly quote. A `WordBoundaries` frame trails its own flush's `FlushDone` (~20 ms, measured against the sandbox host), so guarding on `turn.inFlight()` dropped the last segment's timings on every reply — the tail then degraded to the proportional heard-cursor estimate over exactly the span where per-flush padding makes it worst. The sentence-boundary and coalescer closer classes now carry `’` and `”`, which is what an LLM emits by default; a straight-only class cut mid-sentence and tripled the run-to-run duration spread (18% -> 6%) at identical time-to-first-audio.
