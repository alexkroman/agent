---
"@alexkroman1/aai": patch
---

Trim AssemblyAI agent_context at the documented 1500-character cap instead of 1750, so the host-side tail-preserving trim decides what to drop rather than the service.
