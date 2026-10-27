---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": patch
---

AssemblyAI TTS now sends a `KeepAlive` frame when its socket has been quiet for
`TTS_KEEPALIVE_INTERVAL_MS` (30 s). The service closes a socket that receives
nothing for 120 s, and the pipeline treats that close as fatal, so a long
stretch with no agent speech used to end the call: on a tau2 retail run the
session tore down and the agent answered none of the caller's next four
utterances.
