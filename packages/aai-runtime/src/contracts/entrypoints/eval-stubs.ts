// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval-stubs`.
 *
 * The SDK stubs an eval case COMPOSES with — the model gateway's routes
 * (`stubGatewayRoute`), the step fetch (`installStubStepFetch`),
 * a delegated loop, speech, transcription and uploads, the recording workflow
 * client, the dialog envelope and the event readers — as `/eval/vitest`
 * re-exports them, so an eval file reaches its whole harness through one
 * import.
 *
 * DECLARED in `@alexkroman1/aai` (`/testing`, `/testing/vitest`), where
 * `aai:testing` versions them for a tool's or a step's own spec. This contract
 * is the promise that the ONE eval door keeps carrying them: a name dropped from
 * the re-export list breaks an eval file that never imported the SDK's testing
 * subpaths, and that is this package's change to classify, not the SDK's.
 *
 * Its own capability rather than part of `eval`: the stubs' signatures move
 * with the SDK, and an SDK stub growing an option is not a change to the
 * harness that runs the case.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval/vitest`, and from the two
 * testing doors (`/testing` the pure stubs, `/testing/vitest` the installers);
 * the rest of the SDK's helpers on those doors are `testing-stubs`'. This file
 * is not shipped and nothing imports it — it exists so `pnpm check:api-contracts` can
 * extract a report for this capability alone, hash it, and hold it to a
 * committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  createRecordingWorkflows,
  dialogRefusalPattern,
  dialogResultSchema,
  eventsOf,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  isEvent,
  type RecordingWorkflows,
  type RecordingWorkflowsOptions,
  type StubGatewayRoute,
  type StubSpeech,
  type StubSpeechOptions,
  type StubStepDelegate,
  type StubStepFetch,
  type StubTranscribe,
  type StubTranscribeOptions,
  type StubUploads,
  type StubUploadsOptions,
  stubGatewayRoute,
} from "../../eval-vitest-barrel.ts";
