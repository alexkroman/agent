---
"@alexkroman1/aai-ui": minor
---

Fix sync-mode microphone failing with "Unable to load a worklet's module": the capture worklet now loads from a blob URL (allowed by the agent page CSP) instead of a data URI (blocked). The export is renamed CAPTURE_WORKLET_DATA_URI -> CAPTURE_WORKLET_MODULE_URL, and the hold-to-record pipeline is now available as createPttRecorder. SyncChatView is rebuilt as a push-to-talk console in the same visual design as the WebSocket ChatView (logo + live-status eyebrow header, raised output card, design-system button): recording runs while the button is held, each release sends one POST /sync turn, and the view shows the transcript, the reply, and the endpoint the utterance is sent to.
