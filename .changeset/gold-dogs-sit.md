---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
---

Consolidate session.ts + pipeline-session.ts into a unified SessionCore with two transport strategies (S2S, pipeline). Switch connectS2s to typed callbacks (removing the nanoevents-backed S2sHandle emitter) and flatten client→server→provider dispatch from four layers to two. Client↔server wire format is JSON text events + raw binary PCM audio frames — unchanged from origin/main. Adds Deepgram as a pipeline-mode STT option and Rime as a pipeline-mode TTS option.
