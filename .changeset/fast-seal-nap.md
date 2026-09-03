---
"aai-server": patch
---

Forward AAI_DEBUG from the server's env into an agent guest's boot env, so a deployed guest's debug logging can be switched on at all. debugLoggingEnabled is a module-level const over process.env and a guest's own env arrives as a boot file that is never merged into it, so every runtime debug line — including platform-rpc.ts's per-call decomposition of the guest to platform journal RPC, the only place that RPC exists — was dead in production. Forwarded explicitly like AAI_GUEST_IDLE_EXIT_MS, so the minimal-env property is preserved: the guest still inherits nothing. Boot-time only, and per replica.
