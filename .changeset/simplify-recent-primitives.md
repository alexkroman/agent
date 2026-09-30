---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-runtime": patch
---

Internal cleanups with no API change: the device inbox indexes holders by
client, `stepClientTranscript` reads sessions a few at a time, a resumed
session reads its own log alongside `sessionContext`, and `ConversationView`
no longer rebuilds log rows on live-item changes.
