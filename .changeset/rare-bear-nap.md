---
"@alexkroman1/aai": major
---

BREAKING: a tool's fields are `input` and `run`, and the previous names (`inputSchema`, `execute`) are removed rather than deprecated. `run` is required, which retires the machinery the alias needed: `DefinedTool`, the `toolInput`/`toolRun` accessors on `@alexkroman1/aai/internal`, and `runTool()` from `@alexkroman1/aai/testing` — call `myTool.run(args, ctx)` directly. Rename the two fields; there is nothing else to do.
