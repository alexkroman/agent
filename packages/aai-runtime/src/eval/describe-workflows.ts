// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeWorkflowEval` — a gated eval suite for a WORKFLOW APP.
 *
 * The sibling of `describeEval` and the same three decisions (is there a key,
 * what does a keyless run still prove, which mode did I get) answered for the
 * other kind of agent: one with no session to open, whose product is a durable
 * run. Read `describe.ts` for the argument; only what DIFFERS is here.
 *
 * Two things differ, and both are about honesty rather than convenience.
 *
 * **The credential gate reads `requiredEnv`.** `describeEval` asks
 * `evalCredentials`, which reports `[]` missing for a `page: "static"` agent —
 * correctly, since a workflow app opens no provider socket from a session. Asked
 * alone it makes every keyless workflow suite go LIVE and fail on a 401 inside a
 * step, so this asks `resolveWorkflowEvalMode`, which is the union of the
 * provider names and the `requiredEnv` the app declares.
 *
 * **There is no `stubReply`, and a case is handed the MODE instead.** A voice
 * agent has exactly one model, so a scripted reply is a complete description of
 * a stub run; a workflow's steps reach a model, a transcription endpoint, an
 * upload store, a stranger's web server, and every one of those has a published
 * fake already (`installStubUploads`, `installStubStepFetch`,
 * `installStubTranscribe`, `installStubSpeech` on
 * `@alexkroman1/aai/testing/vitest`). Inventing a per-provider option here
 * would be a second vocabulary over those, and it would mean this module
 * choosing which calls a LIVE eval really makes. So a case installs what it
 * needs and branches on `mode`:
 *
 * ```ts no-check
 * describeWorkflowEval(agentDef, (test) => {
 *   test("transcribes the recording it was given", async ({ app, mode }) => {
 *     installStubUploads({ upl_1: { bytes: wav, name: "standup.wav" } });
 *     if (mode === "stub") installStubTranscribe({ text: "hello there" });
 *
 *     const run = await app.run(transcribe, { recording: "upl_1" });
 *     expect(run.status).toBe("completed");
 *     expect(run.output?.transcript).toMatch(/hello/i);
 *   });
 * });
 * ```
 *
 * **A run here is not durable.** `eval/workflow-engine.ts` says exactly what
 * that costs; nothing declared with this may be reported as covering replay,
 * resume or retry.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { describe, test } from "vitest";
import {
  announceEvalCoverage,
  announceEvalMode,
  type EvalMode,
  registerEmptySuiteFailure,
} from "./_announce.ts";
import { resolveWorkflowEvalMode } from "./describe.ts";
import {
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalWorkflowCredentials,
  openEvalWorkflows,
} from "./workflows.ts";

/**
 * What a missing declared credential is worth in stub mode.
 *
 * A step reads its key with `requireStepEnv`, which THROWS by name for a key the
 * agent env does not carry — so without this a scripted run of any workflow app
 * fails on the credential rather than on anything a case wrote, which is exactly
 * the "keyless run proves the wiring" property `describeEval` exists to protect.
 * Nothing real is dialled in stub mode, so a placeholder is the honest value; it
 * is recognizable on the off chance one reaches a provider, which would mean a
 * case forgot to fake something.
 *
 * The same decision `installStubLlm` makes by handing back an env carrying
 * `STUB_LLM_API_KEY_ENV`.
 */
const STUB_ENV_VALUE = "aai-eval-stub-credential";

/** What a workflow case gets to say about how it should be run. */
export type EvalWorkflowCaseOptions = {
  /**
   * This case only means something against real providers — it is SKIPPED in
   * stub mode.
   *
   * Reach for it when a step MUST reach the far side for the claim to mean
   * anything: a transcript that has to be of the audio, a summary that has to
   * be of the page. A case that can be scripted should be, because a scripted
   * run is what a pipeline with no key can still gate on.
   */
  readonly live?: boolean;
};

/** What a workflow case body is handed. */
export type EvalWorkflowTestContext = {
  /** Opened for this case, closed after it. */
  readonly app: EvalWorkflows;
  /**
   * Which mode this run got.
   *
   * Unlike a voice case, a workflow case is EXPECTED to branch on it: it is what
   * decides whether to install a fake for a provider a step would otherwise
   * really dial.
   */
  readonly mode: EvalMode;
};

/** Declare one workflow eval case. The app is opened for it and closed after it. */
export type EvalWorkflowTest = (
  name: string,
  body: (ctx: EvalWorkflowTestContext) => Promise<void>,
  options?: EvalWorkflowCaseOptions,
) => void;

/**
 * Declare an eval suite for a workflow app.
 *
 * The signature mirrors `describeEval` down to the two things a LINTER decides —
 * the callback parameter is named `test` (`noMisplacedAssertion` matches the
 * callee identifier) and a case body takes a DESTRUCTURED context
 * (`noDoneCallback` reads the first positional parameter of an async test
 * callback as jest's `done`). Do not tidy either.
 */
export function describeWorkflowEval(
  agent: AgentDef,
  define: (test: EvalWorkflowTest) => void,
  options?: Omit<EvalWorkflowsOptions, "agent">,
): void {
  const { mode, reason } = resolveWorkflowEvalMode(agent);
  // One line, every run, before any case — the same rule `describeEval` follows,
  // through the same stderr write for the same reason (see `announceEvalMode`):
  // a reader who cannot tell a wiring check from a real measurement has been
  // handed the wrong confidence. The wording differs because what is scripted
  // differs: here it is whatever the CASE decided to fake.
  announceEvalMode(
    mode === "live"
      ? `eval: ${agent.name} — LIVE workflow run (${reason}). Its steps really call out.`
      : `eval: ${agent.name} — SCRIPTED workflow run (${reason}). Each case fakes its own providers.`,
  );
  const env = options?.env ?? stubbedEnv(agent, mode);

  describe(agent.name, () => {
    let declared = 0;
    let skipped = 0;
    const evalTest: EvalWorkflowTest = (name, body, caseOptions) => {
      declared += 1;
      const skip = mode === "stub" && caseOptions?.live === true;
      if (skip) skipped += 1;
      const run = skip ? test.skip : test;
      run(name, async () => {
        const app = openEvalWorkflows({ ...options, agent, env });
        try {
          await body({ app, mode });
        } finally {
          await app.close();
        }
      });
    };
    define(evalTest);
    // The same two lines `describeEval` owes, for the same reason and with the
    // same wording: how many of the suite's cases this mode will actually run,
    // and a hard failure when the answer is none. A workflow suite has the
    // sharper version of that hazard — every case being `{ live: true }` is more
    // tempting here, since a scripted run needs the case to install a fake per
    // provider a step reaches — so a keyless CI job going green and empty is
    // easier to arrive at by degrees.
    announceEvalCoverage(agent.name, mode, declared, skipped);
    registerEmptySuiteFailure(agent.name, mode, declared, skipped);
  });
}

/**
 * The agent env a suite runs on: what this machine has, plus a placeholder for
 * every declared key it does not, in stub mode only.
 *
 * In LIVE mode a missing key is not filled in — the mode was only chosen because
 * nothing was missing, and filling one would turn a real call into a 401 that
 * reads as the provider's fault.
 */
function stubbedEnv(agent: AgentDef, mode: EvalMode): Record<string, string> {
  const creds = evalWorkflowCredentials(agent);
  const env: Record<string, string> = { ...creds.env };
  if (mode === "stub") for (const name of creds.missing) env[name] = STUB_ENV_VALUE;
  return env;
}
