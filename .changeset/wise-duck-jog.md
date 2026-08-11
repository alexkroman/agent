---
"@alexkroman1/aai": minor
---

Default the AssemblyAI LLM Gateway model to qwen3-next-80b-a3b (was gpt-5.6-terra). qwen is outside TOOLS_REQUIRE_NO_REASONING, so a bare assemblyAILlm() no longer carries an implicit reasoningEffort none and sends no reasoning_effort at all; the default pipeline is unchanged because assemblyAIPipeline() passes it explicitly.
