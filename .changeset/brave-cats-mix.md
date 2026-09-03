---
"@alexkroman1/aai-runtime": minor
---

Bound the pipeline LLM history by TOKENS, not by message count: the LLM view is now trimmed to a budget derived from the model's context window (25% reserved for the system prompt, tool declarations and the reply), with DEFAULT_MAX_HISTORY kept as a secondary hard cap. Tool-call/result pairs still trim together. A model whose context window this SDK does not know falls back to the message-count cap rather than a guessed window.
