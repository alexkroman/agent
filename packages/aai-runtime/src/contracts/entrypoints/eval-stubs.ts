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
 * `aai:testing` versions them for a tool's or a step's own spec. This is a
 * MIRROR of that capability (`{ "mirrors": "aai:testing" }` in
 * `contracts.json`): no epoch of its own. That the ONE eval door keeps carrying
 * them is checked instead — dropping a name the SDK still exports is refused
 * (`scripts/_api-contracts-mirror.mjs`).
 *
 * Its own capability rather than part of `eval`: the stubs' signatures move
 * with the SDK, and an SDK stub growing an option is not a change to the
 * harness that runs the case.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval/vitest`, and from the two
 * testing doors (`/testing` the pure stubs, `/testing/vitest` the installers);
 * the rest of the SDK's helpers on those doors are `testing-stubs`'. This file
 * is not shipped and nothing imports it — it exists so `pnpm check:api-contracts` can
 * extract its report and hold it to being a pure re-export of `aai:testing`.
 * See `scripts/api-contracts.mjs`.
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
