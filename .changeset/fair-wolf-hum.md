---
"@alexkroman1/aai": patch
---

Stop per-frame debug log spam when S2S socket is closed; sendAudio now silently drops frames matching sendAudioRaw and pipeline/STT behavior. Closure is still logged once via the WebSocket close event.
