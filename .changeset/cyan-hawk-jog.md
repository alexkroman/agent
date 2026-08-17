---
"@alexkroman1/aai": minor
---

assemblyAITts({ streamingUrl }): point the TTS stage at a sandbox cluster by the URL it is handed out as, matching assemblyAIStt({ streamingUrl }). The bare-host `host` option it supersedes is deprecated and still honoured; the resolved endpoint is now reported in the "Session mode resolved" log, which a host override never reached.
