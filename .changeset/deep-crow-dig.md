---
"@alexkroman1/aai": minor
"aai-server": minor
"aai-templates": minor
---

Add pipeline-mode silence nudge: new silenceTimeoutMs and silencePrompt agent config fields make the assistant proactively take a turn after a period of user silence (capped at 3 consecutive nudges until the user speaks again)
