---
"@alexkroman1/aai": patch
---

New Conversation now replays the agent's greeting. A client `reset` discarded the conversation but never reopened one: the pipeline transport greeted only at session start, so every conversation after the first began on silence. `reset()` now queues the greeting turn after clearing history, and a reset on a closed socket redials as a fresh session instead of resuming (a resume carries `?sessionId=`/`resume=1`, which keeps the server's history and suppresses the greeting).
