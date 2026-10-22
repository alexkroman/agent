// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval`.
 *
 * DRIVING an agent from text to measure what it did: the session with its two
 * speech stages faked, the text-agent and workflow harnesses, the credential
 * gate, their option bags and records, the runtime's own stubs a harness
 * composes with (the scripted model a keyless run falls back to, the fake
 * speech openers, the `node:vm` `run_code` executor), and the vitest suites
 * that choose between live and scripted.
 *
 * ONE capability over two subpaths (`/eval` and `/eval/vitest`) rather than two,
 * for the reason `aai`'s `testing` capability spans `/testing` and
 * `/testing/vitest`: the split between them is which files pull the test RUNNER,
 * not which promise is being made. A case moving from a hand-rolled `test()` to
 * `describeEval` crosses that line without the promise changing.
 *
 * What a case ASSERTS with — every reader and claim, and the `EvalTurn` /
 * `EvalToolCall` records they read — is `eval-assert`'s, which moves only when
 * a record does. The SDK's stubs an eval composes with are `eval-stubs`, a
 * mirror of `aai:testing`; the runtime's OWN stubs stay here, because a mirror
 * may hold nothing but the SDK's names.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval` and
 * `@alexkroman1/aai-runtime/eval/vitest`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

// `RunCodeExecutor` (what `createVmRunCode` returns) and `HostAgentOptions`
// (what both session option bags extend) are re-exported by the eval barrel so
// a case imports from one subpath, but they are the `runtime` capability's — a
// name belongs to exactly one contract, or a change to it bumps two epochs.
export {
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  DEFAULT_RUN_TIMEOUT_MS,
  type EvalCredentials,
  type EvalEmitted,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSleep,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalCredentials,
  evalTextCredentials,
  evalWorkflowCredentials,
  installStubLlm,
  installStubSpeechProviders,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  type StubLlm,
  type StubScript,
  type StubSpeechProviders,
  type StubStep,
  type StubSttSession,
  type StubTtsSession,
  type VmRunCodeOptions,
} from "../../eval-barrel.ts";
export {
  type DescribeEvalOptions,
  type DescribeTextEvalOptions,
  describeEval,
  describeTextEval,
  describeWorkflowEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  type EvalTextTest,
  type EvalTextTestContext,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
  resolveEvalMode,
  resolveWorkflowEvalMode,
} from "../../eval-vitest-barrel.ts";
