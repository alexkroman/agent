---
"@alexkroman1/aai-server": patch
"@alexkroman1/aai": patch
---

Replace async-lock and p-timeout with p-lock and platform APIs. Consolidate slug-lock.ts into sandbox-slots.ts with two named lock layers. Use AbortController for idle-eviction cancellation and try/finally for teardown resilience in server.ts and sandbox.ts. Drop p-timeout in favor of setTimeout race for arbitrary promises and AbortSignal.timeout for fetch calls.
