---
"@alexkroman1/aai": patch
---

Migrate OpenAI Realtime transport to GA API schema (gpt-realtime-2). Drop OpenAI-Beta: realtime=v1 connect header and update session.update to session.type=realtime, output_modalities, and nested audio.input/audio.output with audio/pcm format.
