---
"@alexkroman1/aai": minor
---

Voice benchmark reliability: preserve completed tool calls/results in LLM history across barge-in aborts (no more repeated or forgotten tool calls after an interruption), settle clearly-complete STT finals briefly instead of committing instantly (plus a longer fragment settle window) so hesitant multi-part requests aggregate into one turn, coerce stringified scalar tool arguments to their schema-declared types, raise the default maxSteps to 10, and overhaul the default system prompt for act-first tool calling, full multi-part request completion, and argument fidelity.
