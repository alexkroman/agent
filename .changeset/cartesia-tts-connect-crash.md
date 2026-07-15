---
"@alexkroman1/aai": patch
"@alexkroman1/aai-cli": patch
---

Fix a Cartesia TTS connect failure crashing the whole host process. `client.tts.websocket()` only returns the socket after connect resolves, so on a connect-time failure (e.g. the account is out of credits) the promise rejects before an `error` listener can be bound — and cartesia-js's `TTSEmitter._onError` does a bare `Promise.reject` (a fatal unhandled rejection) when the socket errors with no listener. The adapter now constructs `new TTSWS(client)` directly and binds the `error` listener before connecting, so the failure flows through the normal `tts_connect_failed` path and degrades only that session. As defense-in-depth, the `aai dev` host entry now installs a log-only `unhandledRejection` guard (mirroring aai-server).
