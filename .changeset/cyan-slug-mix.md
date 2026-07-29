---
"@alexkroman1/aai": patch
---

Fix AssemblyAI TTS `language`: translate ISO 639-1 codes to the full names the streaming API requires, and reject unsupported ones at config time. Passing `language: "es"` produced a session that connected, reported ready, and was silently mute — the service refuses a bad value in-band after the socket opens. Bad values now fail in the CLI and the studio's test_agent instead.
