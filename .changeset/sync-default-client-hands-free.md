---
"@alexkroman1/aai-ui": minor
---

The default sync client is now a hands-free voice agent: `SyncChatView`
opens the microphone once via `startSyncMicrophone` and the client-side
energy VAD endpoints each utterance automatically — no push-to-talk button.
One toggle starts and ends the conversation; `createPttRecorder` remains
exported for custom hold-to-record clients.
