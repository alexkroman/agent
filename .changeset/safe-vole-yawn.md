---
"@alexkroman1/aai": minor
---

Enable voice isolation (voice focus) by default in S2S mode: the session.update config now sends voice_focus: "near-field", matching the pipeline-mode STT default. Override via S2sSessionConfig.voiceFocus ("near-field" | "far-field" | "off"); set "off" to disable.
