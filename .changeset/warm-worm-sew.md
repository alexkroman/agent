---
"aai-server": patch
---

Pass matching cpu/memoryMiB reservations alongside cpuLimit/memoryLimitMiB when creating Modal sandboxes — modal 0.9.0 rejects a bare hard cap ("must also specify cpu when cpuLimit is specified"), which broke every guest sandbox spawn in environments setting SANDBOX_CPU_LIMIT/SANDBOX_MEMORY_LIMIT_MB.
