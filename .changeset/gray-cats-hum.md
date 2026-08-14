---
"@alexkroman1/aai": major
---

The three network builtins (`fetchJson`, `visitWebpage`, `webSearch` on `@alexkroman1/aai/tools`) now return `T | ToolFailure`. Their failure has always been an ANSWER rather than a throw — a model-facing contract that is not changing — but `Promise<T>` hid it, and all three callers in this repo wrote `?? []` / `?? ""`, which turns a refusal into an empty answer. Measured: DuckDuckGo answered 403 to both endpoints, so `research-desk` and `plan-desk` reported "No results." for every search with the refusal nowhere; research-desk even had a `catch` for it, which a returned value never reaches. Narrow with `isToolFailure`. An UNTYPED call is unaffected (`DefaultToolResult` is `any`), so only call sites precise enough to name a shape are asked to handle the failure they were already receiving. `aai:builtins` epoch 1 is dropped.
