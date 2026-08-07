---
"@alexkroman1/aai": patch
---

Default the AssemblyAI LLM Gateway model to `gpt-5.6-terra` (was `gpt-5.5`).

`ASSEMBLYAI_LLM_DEFAULT_MODEL` is what a bare `assemblyAILlm()`, every unset stage of a partial provider triple, and `assemblyAIPipeline()` all resolve to, so this moves the default pipeline's LLM for every agent that does not name one.

It also moves the default across `TOOLS_REQUIRE_NO_REASONING`: `gpt-5.6-terra` rejects a tool-carrying request at any effort other than `"none"` — including the model's own server-side default — so the factory now fills `reasoningEffort: "none"` for the bare descriptor where under `gpt-5.5` it filled nothing. Without that fill the descriptor would fail on every turn of every agent (`DEFAULT_BUILTIN_TOOLS` puts four tools on each one), and because the pipeline streams, the gateway's explanatory 400 arrives as a bare `{"message":"something went wrong","code":500}` — a config error wearing an outage's clothes. `assemblyAIPipeline()`'s own explicit `"none"` now agrees with the factory rather than carrying the whole weight, and stays as the backstop for the next id change.

Terra is advertised by the gateway with tools, streaming, a 270k context and a passing liveness probe, and shares `gpt-5.6-luna`'s reasoning constraint 4/4. It has no paired latency numbers, no price comparison, and no quality run of its own — the measured case in the guide is luna's. Treat the new default as unverified on latency and quality; `assemblyAILlm({ model })` pins any catalog id.
