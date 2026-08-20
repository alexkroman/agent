---
"@alexkroman1/aai": patch
---

Opt the pipeline session's `AbortSignal` into Node's max-listeners warning. Node's leak warning covers `EventEmitter` only, so an abort listener that outlives its turn accumulated on a call-lifetime signal with nothing reported.
