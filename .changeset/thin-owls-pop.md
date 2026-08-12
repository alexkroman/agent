---
"@alexkroman1/aai": minor
---

tool() now takes `input` and `run` — the same two field names `workflow()` uses, so a tool and a workflow differ by one word. The previous names, `inputSchema` and `execute`, are accepted for one more major and normalized away by `tool()`; they are marked deprecated on `ToolDef`, so an editor flags them at the call site. `tool()` now returns a `DefinedTool`, whose `run` is not optional, and `@alexkroman1/aai/testing` gains `runTool(def, args, ctx)` for calling a def read back out of an agent's `tools` record.
