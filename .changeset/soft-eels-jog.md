---
"@alexkroman1/aai-ui": minor
---

Fix sync-mode microphone failing with "Unable to load a worklet's module": the capture worklet now loads from a blob URL (allowed by the agent page CSP) instead of a data URI (blocked). The export is renamed CAPTURE_WORKLET_DATA_URI -> CAPTURE_WORKLET_MODULE_URL. SyncChatView is redesigned to match the WebSocket ChatView console: logo + status eyebrow header, raised conversation card with shared message bubbles and thinking dots, and design-system buttons.
