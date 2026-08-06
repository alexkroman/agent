---
"@alexkroman1/aai": patch
---

Default holdPhrase to "" (off), timestamp every log line, put the STT end-of-turn confidence on the wire, and move per-interim STT logs behind AAI_DEBUG_PARTIALS. The hold phrase covered ~1s of silence (LLM time-to-first-text p50 1.10s measured on tau2-bench retail) while costing the first sentence, which the voice rules reserve for the answer because interruption rate climbs with reply length; dead-air cover still handles long tool chains. Set a phrase to reinstate it.
