---
"@alexkroman1/aai": patch
---

`sttPrompt` defaults to empty again — contextual biasing stays opt-in in both session modes. The generic spelled-identifier default (added after the last release, never shipped) is reverted: its measured FDB-v3 win does not transfer to a line whose callers never spell anything, where the same prose biases the transcript toward alphanumeric codes that were never said. Only the agent author knows the vocabulary, so only they can set a prompt that helps — `DEFAULT_STT_PROMPT` documents what an effective one looks like.
