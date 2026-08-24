// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval`.
 *
 * Driving an agent from TEXT to measure what it did — the session with its two
 * speech stages faked, the readers over its event stream, the credential gate,
 * the scripted model a keyless run falls back to, and the vitest suite that
 * chooses between them.
 *
 * ONE capability over two subpaths (`/eval` and `/eval/vitest`) rather than two,
 * for the reason `aai`'s `testing` capability spans `/testing` and
 * `/testing/vitest`: the split between them is which files pull the test RUNNER,
 * not which promise is being made. A case moving from a hand-rolled `test()` to
 * `describeEval` crosses that line without the promise changing.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval` and
 * `@alexkroman1/aai-runtime/eval/vitest`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createFakeSttOpener,
  createFakeTtsOpener,
  type EvalCredentials,
  type EvalSession,
  type EvalSessionOptions,
  type EvalToolCall,
  type EvalTurn,
  evalCredentials,
  FAKE_SPEECH_API_KEY_ENV,
  type FakeSpeech,
  type FakeSttSession,
  type FakeTtsSession,
  installFakeSpeech,
  installStubLlm,
  openEvalSession,
  STUB_LLM_API_KEY_ENV,
  type StubLlm,
  saidIn,
  TURN_ENDS,
  toolCallsIn,
} from "../../eval-barrel.ts";
export {
  describeEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  resolveEvalMode,
} from "../../eval-vitest-barrel.ts";
