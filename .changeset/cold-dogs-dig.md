---
"@alexkroman1/aai": minor
---

Pipeline provider stages are now individually optional: declare any subset of stt/llm/tts and unset stages are filled from the default all-AssemblyAI pipeline (agent({ llm: "claude-sonnet-4-6" }) swaps just the model). New top-level voice field on agent() picks the default pipeline's TTS voice (voice: "michael"), desugaring to tts: assemblyAITts({ voice }); it is a compile error alongside an explicit tts descriptor or s2s. The assemblyAIPipeline() spread is no longer needed on the golden path and remains for explicitness and region: "eu".
