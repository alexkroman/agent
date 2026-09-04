---
"aai-studio-client": patch
"aai-studio-server": patch
---

Studio client: read the project/chat event streams with the SDK's published `readEventStream` instead of a third private copy of the SSE parser, and narrow each pushed frame with a real guard instead of casting a `JSON.parse`.
