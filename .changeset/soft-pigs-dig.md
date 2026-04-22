---
"@alexkroman1/aai": patch
---

Pipeline session concurrency fixes: serialize turns across duplicate STT finals, bound TTS flush with abort+timeout, cascade provider errors to terminate session, atomic provider open, snapshot conversation history in tool executions.
