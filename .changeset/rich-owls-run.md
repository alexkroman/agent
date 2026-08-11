---
"@alexkroman1/aai": minor
---

Default sttPrompt to a spelled-out-identifier bias prompt, applied in both session modes. Previously transcription was unbiased unless an agent set sttPrompt, and a dropped spoken identifier reaches the LLM missing rather than misheard — the model then fills the required tool argument with something plausible and the turn fails silently. Agents whose callers never spell identifiers should set their own sttPrompt, or "" to opt out.
