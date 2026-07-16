---
"aai-server": patch
---

Use `AbortSignal.timeout` for the sandbox fetch timeout, `Promise.withResolvers` for NDJSON/guest RPC correlation, and `structuredClone` for per-session state isolation.
