---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Testing and server helpers, one way each: `expectToolOk` now infers and accepts a plain `tool()` result (a dialog envelope is still unwrapped, a refusal still throws); `scriptedToolContext` is deprecated for `createToolContext({ generate, delegate })`; `createRuntimeServer` is renamed `createServerForRuntime` (the old name stays as a deprecated alias); `WorkflowOutputOf` joins `WorkflowInputOf`/`WorkflowRunOf` on the `@alexkroman1/aai` root. Doc comments now say which gateway fake, tool runner, result reader and eval credential gate fits which case.
