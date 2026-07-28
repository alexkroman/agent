---
"@alexkroman1/aai": minor
---

Text-only agents: `tts: none()` runs pipeline mode without synthesis (STT → LLM, text replies). No TTS credential required; the config message stamps `audioOut: false`; aai-ui adds opt-in mic recording (`startRecording`/`stopRecording`), audio-file upload (`sendAudioFile`), a text-only default UI (record + upload + text replies), and an always-visible API endpoint chip (`ApiUrlChip`, `SessionSnapshot.apiUrl`) in every session mode.
