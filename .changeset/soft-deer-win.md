---
"@alexkroman1/aai": patch
---

Split the S2S wire-message dispatch out of s2s.ts into _s2s-dispatch.ts; S2sCallbacks moves with it and is re-exported, so no import changes
