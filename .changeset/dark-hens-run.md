---
"@alexkroman1/aai-runtime": minor
---

S2S sessions now emit one `metrics.collected` frame per settled reply (`interrupted`, plus end-of-speech to first-audio `latencyMs`), and S2S tool calls run through the same per-call core as the pipeline's — so a stringified scalar argument (`"4"`) is coerced to the declared type on S2S too.
