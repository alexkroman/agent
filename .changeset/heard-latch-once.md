---
"@alexkroman1/aai-runtime": patch
---

Pipeline mode: a repeated cut on the same reply no longer re-reads the (already reset) playback clock, which latched the whole reply as heard and kept unheard text in history.
