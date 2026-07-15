---
"@alexkroman1/aai": patch
---

Pipeline mode: add a configurable `minBargeInWords` option (default 1, preserving instant barge-in) that requires the interim STT transcript to reach N words before interrupting the agent — raise it to ignore one-word backchannels while the agent speaks. Also persist the agent's spoken-so-far text on interruption (flagged `[interrupted]` in history) so the next turn's LLM knows it was cut off, instead of discarding it.
