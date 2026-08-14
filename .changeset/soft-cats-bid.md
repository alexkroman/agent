---
"@alexkroman1/aai": minor
---

Durable workflow steps can do real work. A `"use step"` body is handed no tool context, so until now nothing in one could authenticate an outbound call and every workflow template's I/O was a fixture. Two additions on `@alexkroman1/aai/utils` close it: `stepEnv`/`requireStepEnv` read the agent env (published by the guest at bundle load and by `aai dev` on every rebuild), and `stepGenerate` is `ctx.generate`'s counterpart for a step — one request to the AssemblyAI LLM Gateway on the agent's own key and default model, with `StepGenerateError.retryable` saying whether another attempt is worth it. All three workflow templates are real on top of them: `transcription-workflow` splits a WAV recording into chunks the sync transcription API accepts, transcribes each chunk in its own step and stitches the overlapping results together; `research-workflow` plans angles, investigates each one and writes them up; `link-digest` fetches a page and reduces it.
