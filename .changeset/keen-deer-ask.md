---
"@alexkroman1/aai": minor
---

Host mode accepts an sttPrompt in its config block, and the pipeline traces the STT→LLM boundary under AAI_DEBUG=1 (each STT partial/final, the committed turn text, and each raw AssemblyAI turn event with its end_of_turn/turn_is_formatted flags). DEFAULT_STT_PROMPT is exported and empty — biasing stays opt-in.
