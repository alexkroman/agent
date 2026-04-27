---
"@alexkroman1/aai": patch
---

Fix Rime TTS provider: correct WebSocket host (users-ws.rime.ai), JSON message protocol on /ws2, longer first-audio timeout so the greeting plays. Default voice for cartesia() and rime() so they can be called with no args.
