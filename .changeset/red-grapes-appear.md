---
"@alexkroman1/aai-ui": patch
---

Fix start-of-greeting audio cutoff in S2S mode. The client used to silently drop audio chunks that arrived from the server before `getUserMedia` and worklet registration completed. Early chunks are now buffered and replayed in order once playback is ready.
