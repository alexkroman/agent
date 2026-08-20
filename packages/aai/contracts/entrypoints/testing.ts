// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `testing`.
 *
 * Testing a tool's `execute` in a user's own project: a `ToolContext` with
 * inert defaults and a recording `send`, the fakes its collaborators are driven
 * by (a model, a workflow client, a gateway), the three slots a `"use step"`
 * body reaches through — the upload store, the HTTP `stepFetch` makes its
 * request with, and the synthesizer `stepSpeak` speaks through — and
 * `withDiscoveredTools`, which is how a spec gets the def a DEPLOYED
 * agent runs when the project's tools are files rather than inline.
 *
 * Re-exported from `@alexkroman1/aai/testing` and its `/vitest` half — one
 * capability across two subpaths, because they are one promise to an author:
 * what is on the second is only the INSTALLATION of what is on the first, split
 * off so the test-runner dependency is opt-in.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createUnusedDb,
  type RunSnapshotOverrides,
  runTool,
  type SentEvent,
  type StubEmitted,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  type StubReporter,
  STUB_SPEECH_PCM_BYTES,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  type StubStepFetch,
  type StubStepRequest,
  type StubUpload,
  type StubUploadsOptions,
  stubGateway,
  stubGenerate,
  stubReporter,
  stubSpeech,
  stubStepFetch,
  stubUploads,
  type TestToolContext,
  type ToolBearingAgent,
  toolOf,
  withDiscoveredTools,
} from "../../sdk/testing.ts";
export { installStubGateway } from "../../sdk/testing-vitest.ts";
