---
"@alexkroman1/aai": patch
---

Accept GA-renamed Realtime server events. The new gpt-realtime-2 model emits response.output_audio.{delta,done} and response.output_audio_transcript.{delta,done}; route those alongside the legacy response.audio.* names so audio and transcript reach the client. Also log unhandled event types and the full payload of error events to make session.update issues visible.
