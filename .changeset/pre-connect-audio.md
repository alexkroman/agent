---
"@alexkroman1/aai-ui": minor
---

Buffer audio spoken before the session connects. The browser session now opens
the microphone on `connect()` instead of waiting for the server's `config`
frame, keeps the latest 10 seconds of what the caller says while the agent is
still joining, and sends it ahead of the live stream once the session is
configured — so an eager opener is no longer lost. The capture runs at 16 kHz
and is adopted as-is when the agent's STT rate matches, or resampled by the
browser when it does not. Opt out with `createBrowserSession({ preConnectAudio: false })`.
