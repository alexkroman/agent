---
"@alexkroman1/aai-runtime": patch
---

Bound a step's outbound HTTP again. The step fetch pool had undici's header and body timeouts disabled, justified partly by a step budget the DevKit removal deleted, so a `stepFetch` call passing no signal had a deadline from no layer at all. Both are set to a 10-minute INACTIVITY bound — undici's timers are phase timers, not total-duration ones, so the number does not scale with the payload — and the walk's `AbortSignal` now reaches every step request, so a cancelled run stops its in-flight I/O instead of finishing an upload nobody is waiting for.
