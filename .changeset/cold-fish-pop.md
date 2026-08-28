---
"@alexkroman1/aai": major
---

One name per concept: `agent({ system })` and `SubagentDef.instructions` are both `systemPrompt`; `TextTurnOptions.system` too. `webSearch` takes `maxResults` in the options bag and nowhere else. The workflow hooks' def type parameter is required.
