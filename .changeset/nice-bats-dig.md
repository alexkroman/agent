---
"@alexkroman1/aai": patch
---

Make RuntimeOptions stt/llm/tts descriptor-only, removing the pre-resolved-opener escape hatch, the opener.name sniffing it required, and the duplicated raw-descriptor channel in the transport factory.
