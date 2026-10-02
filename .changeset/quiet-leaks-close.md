---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

An MCP connect that times out now aborts its in-flight fetches instead of
leaving them to the SDK's own request timeout. The orchestrator exposes
`stopSweeps` so a test-built one stops its queue sweep.
