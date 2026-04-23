---
"@alexkroman1/aai": patch
---

Instrument slow reply_done dispatches with warn-level logs (session id, duration, hadTurnPromise) to help diagnose event-loop starvation under load.
