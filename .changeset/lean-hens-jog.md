---
"@alexkroman1/aai-runtime": minor
---

Publish a scripted-model test harness for text agents on `@alexkroman1/aai-runtime/testing`: `scriptedTextModel(steps)` builds the `LanguageModel` a spec hands `createTextAgent({ model })`, and `runTextAgent(def, input, { script })` drives one turn through the real `createTextAgent`, the real tool executor and the real tool `ctx`, handing back the text, the tool calls in order with their arguments and results, the steps, and the messages the turn appended. Replaces the hand-written provider fakes (and their `as unknown as LanguageModel` casts) that every caller was writing, each copy re-deriving the `finish` frame whose bare-string `finishReason` silently stops every tool from running.
