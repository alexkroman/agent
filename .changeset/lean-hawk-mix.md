---
"@alexkroman1/aai": patch
---

createServer().close() drops idle keep-alive connections instead of waiting out their timers, so `aai dev` shuts down and restarts promptly. In-flight requests still finish.
