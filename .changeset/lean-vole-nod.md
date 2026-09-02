---
"@alexkroman1/aai-runtime": patch
---

A malformed base64 audio frame is now reported — one warning per 10s per logger, carrying the running count — instead of being dropped silently. The three callers that own a session log there; the three provider openers use the default logger.
