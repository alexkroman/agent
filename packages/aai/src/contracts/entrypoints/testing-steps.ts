// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing-steps`.
 *
 * Testing a workflow STEP body: the fakes behind the slots a step reaches
 * through — the upload store (`stubUploads`), the synthesizer `stepSpeak`
 * speaks through (`stubSpeech`), AssemblyAI's transcription endpoints
 * (`stubTranscribe`, which refuses by HTTP status so the SDK's own classifier
 * runs), the step reporter (`stubReporter`), the carrier `stepPlaceCall` dials
 * (`stubPlaceCall`), `stepDelegate`'s desk (`stubStepDelegate`) and
 * `stepInfo` (`stubStepInfo`) — each with its `/vitest` installer.
 *
 * Split off `testing` because each fake moves with its step, not with a tool's
 * context. Part of the `testing` family: `aai-runtime`'s `testing-stubs` door
 * mirrors the whole family.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  STUB_SPEECH_PCM_BYTES,
  type StubEmitted,
  type StubPlaceCall,
  type StubPlaceCallOptions,
  type StubPlaceCallRefusal,
  type StubPlacedCall,
  type StubReporter,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  type StubStepDelegate,
  type StubTranscribe,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubTranscribeOptions,
  type StubUpload,
  type StubUploads,
  type StubUploadsOptions,
  type StubUploadWrite,
  stubPlaceCall,
  stubReporter,
  stubSpeech,
  stubStepDelegate,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
} from "../../sdk/testing-barrel.ts";
export {
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubTranscribe,
  installStubUploads,
} from "../../sdk/testing-vitest-barrel.ts";
