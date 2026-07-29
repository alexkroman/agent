---
"@alexkroman1/aai": patch
---

Pipeline mode: cover tool-execution dead air with time-based filler speech. holdPhrase only fired when a turn *opened* with a tool call, so a model that spoke first and then chained tool calls left the caller in silence for the whole chain (15-24s in benchmark runs). Silence during tool execution now gets a filler after 2s regardless, repeating with exponential backoff until the model speaks again. `holdPhrase: ""` disables both.
