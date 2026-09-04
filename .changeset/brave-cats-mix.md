---
"@alexkroman1/aai-runtime": minor
---

Bound what a pipeline step SENDS the model by tokens rather than by message count. A `prepareStep` preparer trims the request to the model's advertised context window less an explicit 25% reserve for the system prompt, the tool declarations and the reply, calibrating its estimate against each completed step's reported `usage.inputTokens`; conversation history itself is untouched, so the client replay, resume and `ctx.messages` still see everything and `DEFAULT_MAX_HISTORY` stays as the guard on unbounded growth. Tool-call/result pairs trim together, and a model whose context window this SDK does not know is left entirely alone rather than trimmed against a guessed window.
