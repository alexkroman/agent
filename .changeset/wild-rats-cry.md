---
"aai-server": patch
---

Cache gVisor rootfs prep, async fs, off-thread pool replenish; fixes 13s event-loop block on first sandbox spawn that failed Fly healthchecks. Also adds per-phase timing logs and enables SANDBOX_POOL_SIZE=2 in production.
