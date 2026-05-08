---
"@alexkroman1/aai": patch
---

Make OpenAI Realtime usable end-to-end on gpt-realtime-2:

- Accept GA-renamed audio/transcript server events (`response.output_audio.{delta,done}`, `response.output_audio_transcript.{delta,done}`) alongside the legacy `response.audio.*` names so audio and transcript reach the client.
- Trigger the agent's `greeting` on connect by sending a one-shot `response.create` with quoted instructions, and honor `skipGreeting` so resumed sessions don't replay it.
- Coalesce `response.create` across multiple `sendToolResult` calls in the same tick. Multi-tool turns previously sent one `response.create` per tool, the second of which OpenAI rejected as `conversation_already_has_active_response`, stranding the turn so the model never received the tool results.
- Log unhandled event types and the full payload of `error` events to make silently rejected `session.update` fields visible.
