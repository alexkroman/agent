---
"@alexkroman1/aai-runtime": patch
---

Pipeline mode's fixed lines — the greeting, the error phrase and the start-failure phrase — now go through one send. An interrupted greeting records only what the caller heard (marked `[interrupted]`, or nothing if nothing was audible) instead of the whole line, and the error phrase is captioned once as a final rather than as an interim followed by an identical final.
