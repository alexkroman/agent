---
"@alexkroman1/aai": major
"aai-server": major
---

Remove the text-only agent mode: an agent is always a voice conversation, and a workflow never speaks.

- `agent()` with `tts: none()` is now rejected at parse time (parseManifest, toAgentConfig, and the platform's IsolateConfigSchema) — speech-in, text/action-out apps are workflows.
- `workflow()` no longer accepts a `tts` parameter; it always sets the internal `none()` sentinel.
- aai-ui: `TextControls` is removed and `ChatView` always renders the voice `Controls`. `SessionCore`'s programmatic audioOut-aware APIs (`startRecording`, `sendAudioFile`) remain.
- The `pipeline-text-only` template and the studio's text-only starter are removed.
