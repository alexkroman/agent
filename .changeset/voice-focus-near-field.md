---
"@alexkroman1/aai": minor
---

Enable AssemblyAI voice focus (noise suppression) by default: the streaming STT provider now sends `voice_focus: "near-field"` at connect. Configurable via the `voiceFocus` option (`"near-field"` | `"far-field"` | `"off"`); set `"off"` to disable.
