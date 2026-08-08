---
"@alexkroman1/aai": patch
---

Stop publishing the s2s-transport connectS2s spy seam from the runtime barrel: a mutable test-patch object was part of the public API and could be overwritten process-wide.
