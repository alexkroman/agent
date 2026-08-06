---
"@alexkroman1/aai": minor
---

Default the AssemblyAI LLM Gateway model to qwen3-next-80b-a3b (was gpt-5.6-luna). The default pipeline still runs with reasoning off, but via assemblyAIPipeline()'s explicit reasoningEffort: "none" rather than the factory's per-model default — qwen accepts reasoning_effort but does not require it, so it is not in TOOLS_REQUIRE_NO_REASONING. A bare assemblyAILlm() therefore no longer carries an implicit "none".
