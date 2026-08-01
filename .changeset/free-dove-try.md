---
"@alexkroman1/aai": patch
---

Stop the type gate from blocking working agents: useToolResult defaults to a permissive result type, and generated projects run strict without noImplicitAny — the implicit-any family was 57% of the diagnostics coding agents had to repair and caught no real defects.
