---
"@alexkroman1/aai": patch
---

Code-quality sweep: reuse shared helpers (errorMessage/toolError, provider utils, TTL cache), remove dead code and leftover diagnostics, fix a session-state leak, cut hot-path allocations (base64 zero-copy, persistent playback worklet, client asset cache), and single-source defaults (DEFAULT_MAX_STEPS, slug regex).
