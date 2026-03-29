---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-cli": patch
"@alexkroman1/aai-server": patch
---

Harden platform security and refactor to @hono/zod-validator

- Fix crash in sandbox-network when host.internal hit without handler
- Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
- Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
- Fix type errors in _harness-runtime.ts and sandbox.ts
- Remove factory.ts, inline into orchestrator
- Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries
