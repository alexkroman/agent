---
"@alexkroman1/aai-runtime": patch
---

Roll an injected prompt back completely when the conversation window is full. `dropTrailingUser` popped where the push had already trimmed, so a resume prompt, silence nudge or `injectTurn` rolled back at the 200-message cap permanently cost the oldest real conversation turn. The LLM view could lose two, since capping can orphan a `tool` result its removal split.
