---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

One SessionDirectory holds the runtime's live sessions by id (session, sink, emitter, meter, speech), so resume takeover semantics live in one module; guard-invariants rule 36 refuses a session-keyed registry anywhere else in aai-runtime.
