---
"@alexkroman1/aai": patch
---

Pipeline transport: replace the two-epoch turn gate with TaskScope (awaitable interrupt + scope-owned timers). The interrupted-turn persistence is now a scope finalizer that cancelReply keeps and reset/stop/terminate discard, and the dead-air cover timer is owned by the turn scope, so neither can race a fresh conversation. No behavior change.
