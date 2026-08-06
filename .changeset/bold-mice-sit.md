---
"@alexkroman1/aai": minor
---

Require `reasoning_effort: "none"` on the `gpt-5.6` gateway models so their tool calls work. Those models reject a tool-carrying request at any other effort — including the server-side default, i.e. sending no `reasoning_effort` at all — and streaming reports that as a bare 500 with the explanation stripped, so an agent selecting one failed on every turn while reading as a gateway outage. `TOOLS_REQUIRE_NO_REASONING` makes the factory fill in `"none"` for those ids, covering the bare factory, the model-id string shorthand, and an explicit `model`; an explicit `reasoningEffort` is still honoured. The default model is unchanged (`gpt-5.5`), which is outside that set, so `assemblyAIPipeline()`'s explicit `reasoningEffort: "none"` remains the only thing turning reasoning off on the default pipeline.
