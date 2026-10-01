---
"@alexkroman1/aai-runtime": major
---

An eval file needs one import: `@alexkroman1/aai-runtime/eval/vitest`.

- `/eval/vitest` now re-exports everything an eval case uses, as the same declarations: the runner-free `/eval` half (sessions, readers, claims, `evalNetwork`, the stub model and speech), the simulated caller and judge (`evalSimulation`, `simulateCall`, `judgeCall` and their types), and the `@alexkroman1/aai/testing` stubs a case composes with (`stubGatewayRoute`, `routeStepFetch`, `createRecordingWorkflows`, `dialogResultSchema`, `dialogRefusalPattern`, `eventsOf`, `isEvent`, and the `installStubStepFetch` / `installStubStepDelegate` / `installStubSpeech` / `installStubTranscribe` / `installStubUploads` installers). Write `import { describeEval, evalSimulation, stubGatewayRoute, toolNames } from "@alexkroman1/aai-runtime/eval/vitest"`.
- `/eval` stays as the runner-free half for a harness that is not vitest, and now also exports the simulated caller and judge.
- **Breaking:** the `@alexkroman1/aai-runtime/eval/simulate` subpath is removed. Import `evalSimulation`, `simulateCall`, `judgeCall` and their types from `/eval/vitest` (or `/eval`).
- `@alexkroman1/aai/testing` is unchanged. It stays the unit-level surface for a tool's or a step's own spec.
- Every template's `agent.eval.test.ts` and the scaffold guide use the one import.
