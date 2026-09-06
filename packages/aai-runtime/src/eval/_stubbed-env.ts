// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent env a SCRIPTED workflow run gets: what this machine has, plus a
 * placeholder for every declared key it does not.
 *
 * A step reads its key with `requireStepEnv`, which THROWS by name for a key the
 * agent env does not carry — so without this a scripted run of any workflow
 * fails on the credential rather than on anything a case wrote, which is exactly
 * the "keyless run proves the wiring" property `describeEval` exists to protect.
 * Nothing real is dialled in stub mode, so a placeholder is the honest value; it
 * is recognizable on the off chance one reaches a provider, which would mean a
 * case forgot to fake something.
 *
 * One module because it is ONE decision made in two places: `describeWorkflowEval`
 * for a workflow app, and `describeEval` for the engine it opens beside a voice
 * agent that hands off to a run. Until the second learned it, both templates with
 * that shape carried a `{ ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ??
 * "eval-scripted-key" }` of their own, under a comment explaining exactly this.
 *
 * The same decision `installStubLlm` makes by handing back an env carrying
 * `STUB_LLM_API_KEY_ENV`.
 *
 * @module _stubbed-env
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { EvalMode } from "./_announce.ts";
import { evalWorkflowCredentials } from "./workflows.ts";

/** What a missing declared credential is worth in stub mode. */
export const STUB_ENV_VALUE = "aai-eval-stub-credential";

/**
 * The agent env a suite runs on: what this machine has, plus a placeholder for
 * every declared key it does not, in stub mode only.
 *
 * In LIVE mode a missing key is not filled in — the mode was only chosen because
 * nothing was missing, and filling one would turn a real call into a 401 that
 * reads as the provider's fault.
 */
export function stubbedEnv(agent: AgentDef, mode: EvalMode): Record<string, string> {
  const creds = evalWorkflowCredentials(agent);
  const env: Record<string, string> = { ...creds.env };
  if (mode === "stub") for (const name of creds.missing) env[name] = STUB_ENV_VALUE;
  return env;
}
