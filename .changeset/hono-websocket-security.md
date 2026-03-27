---
"@alexkroman1/aai": patch
"@alexkroman1/aai-cli": patch
---

Use Hono builtins for WebSocket, security headers, and HTML escaping

- Replace manual WebSocketServer + upgrade handling with @hono/node-ws
- Replace custom escapeHtml() with Hono's html tagged template
- Replace manual CSP string with secureHeaders middleware
- Fix aai rag to use local dev server in dev mode
- Fix vector upsert model loading in local dev mode
- Add missing aws4fetch dependency for unstorage S3 driver
