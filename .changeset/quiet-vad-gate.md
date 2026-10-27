---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`assemblyAIStt({ vadThreshold })`: set the streaming service's voice-activity
threshold (`vad_threshold`). Unset sends nothing, so the service default still
applies. Lower it when a caller's speech goes unheard entirely — no
`speech.started`, no transcript — rather than mis-heard.
