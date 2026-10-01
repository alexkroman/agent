---
"@alexkroman1/aai-runtime": minor
---

A test file imports its testing names from two doors: `@alexkroman1/aai-runtime/testing` and the new `@alexkroman1/aai-runtime/testing/vitest`.

- `@alexkroman1/aai-runtime/testing` now re-exports every name of `@alexkroman1/aai/testing` (`createToolContext`, `runTool`, `expectToolOk`, `stubGenerate`, `createWorkflowContext`, …) as the same declarations, beside `runWorkflow`, `runTextAgent` and `scriptedTextModel`. It still installs nothing and does not import vitest.
- New `@alexkroman1/aai-runtime/testing/vitest`: every installer of `@alexkroman1/aai/testing/vitest` (`installStubGateway`, `installStubStepFetch`, `installFetchRoutes`, …) plus everything `@alexkroman1/aai-runtime/eval/vitest` provides (`describeEval`, the readers, the simulated caller and judge), so one import serves a unit spec and an eval file.
- `@alexkroman1/aai/testing`, `/testing/vitest`, `/testing/vite`, `@alexkroman1/aai-runtime/eval` and `/eval/vitest` are unchanged and keep working. The templates and the authoring guide now import from the two doors.
