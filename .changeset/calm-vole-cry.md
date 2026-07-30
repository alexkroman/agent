---
"@alexkroman1/aai": minor
---

Add a pluggable turn-runner seam to the pipeline transport (llm: null + turnRunner) and createEveTurnRunner, which sources replies from a Vercel eve agent session (run/deliver per user turn, message.appended deltas to TTS, cancelTurn on barge-in). First step of the eve migration; see MIGRATION-EVE.md.
