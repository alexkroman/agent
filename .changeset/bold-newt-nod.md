---
"@alexkroman1/aai": patch
---

Fix two silent-default footguns: ctx.state is now one memoized object per session even when the agent declares no state factory (writes were discarded on every tool call, and syncState projected an empty object), and agent() no longer lets a spread key whose value is undefined clobber the greeting, systemPrompt and maxSteps defaults.
