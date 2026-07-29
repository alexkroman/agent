---
"@alexkroman1/aai": patch
---

Fix every sync turn failing with HTTP 415: the AssemblyAI Sync API request body is now hand-encoded multipart bytes, because a globalThis.FormData is stringified rather than encoded by the pinned undici the host fetch comes from.
