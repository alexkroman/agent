---
"@alexkroman1/aai": minor
---

Three fixes to `@alexkroman1/aai/testing`, all cases where the published surface let a spec compile and then fail at runtime.

`toolRunner` now refuses at BIND time when the agent it is handed declares no tools, with the sentence `toolOf` already carried. A tool is a file, so `agent.ts`'s default export carries none of them — handing the authored def to a runner is the mistake the docs themselves were making, and it surfaced as "declares: (none)" several assertions later.

A `{ text }`-only script is now a compile error in `stubGenerate`, `createToolContext({ generate })` and `scriptedToolContext({ generate })`, via a `StubGenerateRoutes` misuse arm, plus a mirror refusal at bind for JS callers. It previously type-checked and was then read as a route table keyed by the system prompt `"text"`, so every call was rejected for having no matching route. This strictly narrows what compiles; every affected call is broken at runtime today.

`createToolContext`'s `generate` and `delegate` now accept a SCRIPT as well as a function, building the fake for you and exposing it as `ctx.model` / `ctx.desk` — the `stubGenerate` → destructure → `createToolContext` three-step is one call. A function in either position is still the seam itself. `scriptedToolContext` keeps working unchanged. `TestToolContext` gains `model` and `desk`, so a hand-written value of that type needs them.
