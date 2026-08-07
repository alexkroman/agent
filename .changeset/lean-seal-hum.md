---
"@alexkroman1/aai": minor
---

Default the pipeline LLM to gpt-5.6-luna (was gpt-5.5). It is $1/$6 per M against gpt-5.5's $5/$30 and p50 832ms vs 999ms time-to-first-token over 18 paired tool-calling turns with reasoning off on both. Because luna is in TOOLS_REQUIRE_NO_REASONING, the bare assemblyAILlm() now carries an implicit reasoningEffort: "none" — that value is a tool-calling requirement on the gpt-5.6 models, not a tuning knob. assemblyAIPipeline()'s explicit "none" stays: it agrees with the factory on this id but is the only latency guarantee under a default outside that set, and define.test.ts pins the effort and the model id together.
