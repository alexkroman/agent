---
"@alexkroman1/aai": patch
---

Fix AssemblyAI streaming TTS cutting replies short when the server acknowledges a flush with both an is_final audio frame and a FlushDone: the pair now counts as one acknowledgement, so done can no longer fire mid-reply, drop buffered sentence text, or let audio_done overtake segments still synthesizing.
