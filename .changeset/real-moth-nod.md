---
"@alexkroman1/aai": patch
"aai-server": patch
"aai-studio-server": patch
---

Studio packages reuse shared SDK helpers (runCapped, LogLine/formatLogTime,
estimateMessageTokens, walkWorkspaceFiles, ai UI-message helpers) instead of
hand-rolled copies; the studio adopt fetch now aborts on timeout.
