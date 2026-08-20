---
"@alexkroman1/aai": patch
---

Stop advertising `directParts` on an agent whose upload store is not the platform's bucket. A databaseless agent keeps its uploads in its own directory, so the direct-parts claim sent every window over 8 MiB to the platform and then asked the agent to record bytes it had never been given — failing every parts upload with `No bytes are stored for the part at <offset>`.
