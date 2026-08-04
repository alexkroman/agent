---
"@alexkroman1/aai": patch
---

S2S: commit accumulated agent transcript deltas as the reply's final transcript when reply.done arrives without one, so the assistant turn still enters conversation history when the service omits transcript.agent (observed on tool-call follow-up replies).
