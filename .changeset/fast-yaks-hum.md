---
"@alexkroman1/aai-runtime": minor
---

Give `createTextAgent` a typed event stream: `onEvent` reports a text agent's turns as the same `SessionEvent` union a voice session emits, narrowed to what a text agent can honestly report, so an eval reads a text turn with the readers it already has instead of scraping the reply text. `runTextAgent` hands the recorded list back as `TextAgentTestRun.events`. Additive: `TextTurnResult` is still the AI SDK's own `StreamTextResult`.
