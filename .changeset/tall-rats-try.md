---
"aai-server": patch
---

Local dev gets a loopback stand-in for the Supabase Management API (dev-management-api.ts, started by dev-server.mjs), so per-app databases work on the local stack while the server still takes the production create/drop code path. A scenario suite provisions and drops a real database through the real SDK over HTTP against it.
