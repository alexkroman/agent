---
"@alexkroman1/aai": minor
---

Add `agent({ persistSessions: true })`, which makes durable resume reachable from an agent's own config: session state and the S2S provider session are mirrored to the app's database, so a redeploy, crash, or replaced sandbox no longer costs the conversation. Off by default; warns at startup and runs unchanged when storage is not enabled.
