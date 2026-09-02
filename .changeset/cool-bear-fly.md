---
"@alexkroman1/aai-runtime": patch
---

`createRuntime` now refuses `executeTool` without `toolSchemas` (and the reverse) instead of silently running the in-process tool path with no tools. A lone `executeTool` used to discard the caller's relay entirely and answer every call with `Unknown tool`.
