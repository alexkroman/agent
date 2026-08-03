---
"@alexkroman1/aai": minor
---

SDK polish: AgentParams is now a pipeline/S2S mode union — a partial stt/llm/tts triple, or s2s combined with a pipeline provider or pipeline-only tuning field, is a compile error whose message names the rule (previously these were runtime parse failures or silent no-ops). The system alias and llm model-id string shorthand now also work for raw configs that skip agent() (normalized in parseManifest/toAgentConfig). The default TTS voice is now jane (US-accented English); it was vera (UK), which put a UK accent on every agent that never chose a voice.
