// Copyright 2026 the AAI authors. MIT license.
/**
 * WHICH MODEL an eval suite runs against, decided before any case is registered.
 *
 * Three doors ask the same question — `describeEval` for a voice agent,
 * `describeWorkflowEval` for a workflow app, `describeTextEval` for a text
 * agent — and each of them reads a DIFFERENT credential verdict: a pipeline's
 * provider triple, a workflow app's `requiredEnv`, a text agent's LLM alone.
 * What must not differ is what happens once that verdict is in hand, which is
 * why {@link modeFrom} lives here rather than being re-derived at each door:
 * `AAI_EVAL_STUB` and `AAI_REQUIRE_EVAL` have to mean one thing across every
 * eval suite in the repo, and a second copy of that three-branch decision is
 * how one of them comes to be honoured by two doors out of three.
 *
 * Split out of `describe.ts` when that module reached the 500-line cap. The
 * seam is the one a reader already uses: this file decides WHETHER a suite is
 * measuring, and `describe.ts` runs it either way.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { EvalMode } from "./_announce.ts";
import { type EvalCredentials, evalCredentials } from "./session.ts";
import { evalWorkflowCredentials } from "./workflows.ts";

const truthy = (value: string | undefined): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/**
 * Live if this machine can be, stub if it cannot — unless a caller has said
 * which it wants.
 *
 * `AAI_REQUIRE_EVAL` is for a pipeline that means to MEASURE: with it set, a
 * missing credential is a failure instead of a quiet downgrade to a wiring
 * check. `AAI_EVAL_STUB` is the opposite instruction, and CI wants it —
 * a required check must not start spending tokens the day a key reaches its
 * environment, and must not become a flaky gate on a live model's behaviour.
 */
export function resolveEvalMode(
  agent: AgentDef,
  hostEnv: Record<string, string | undefined> = process.env,
  /**
   * What the CASE overrides, which decides the credential question with it.
   *
   * Without this the mode was read off the AGENT alone, so
   * `describeEval(def, define, { llm: assemblyAILlm() })` on an agent declaring
   * `anthropic()` announced "SCRIPTED — ANTHROPIC_API_KEY is not set" while
   * holding the key the run would actually have used. Measured on
   * `custom-pipeline-agent`: the override was honoured by the session and ignored by
   * the gate, so a case could not be run live at all.
   */
  overrides?: { readonly llm?: LlmProvider },
): { mode: EvalMode; reason: string } {
  // The override replaces the LLM and nothing else, so the credential question
  // is asked about an agent carrying it. `omitUndefined` keeps the field ABSENT
  // rather than present-and-undefined, which `exactOptionalPropertyTypes` makes
  // a different type.
  const effective: AgentDef = { ...agent, ...omitUndefined({ llm: overrides?.llm }) };
  return modeFrom(evalCredentials(effective, hostEnv), hostEnv);
}

/**
 * {@link resolveEvalMode} for a WORKFLOW app, whose credentials are a different
 * question.
 *
 * Split rather than folded in because the two gates read different fields and the
 * wrong one is silent: a `page: "static"` agent needs no provider credential, so
 * `evalCredentials` reports every workflow app ready and a keyless run goes LIVE
 * — then every case fails on a 401 three layers down. `evalWorkflowCredentials`
 * reads `requiredEnv`, which is the only thing a workflow app declares its
 * credentials in.
 */
export function resolveWorkflowEvalMode(
  agent: AgentDef,
  hostEnv: Record<string, string | undefined> = process.env,
): { mode: EvalMode; reason: string } {
  return modeFrom(evalWorkflowCredentials(agent, hostEnv), hostEnv);
}

/**
 * The mode decision itself, shared by the two gates above and by
 * `describe-text.ts`, which asks the same question of a different credential
 * verdict. In-package only, never on the barrel — see this module's own doc for
 * why the three doors must not each carry a copy.
 */
export function modeFrom(
  creds: EvalCredentials,
  hostEnv: Record<string, string | undefined>,
): { mode: EvalMode; reason: string } {
  if (truthy(hostEnv.AAI_EVAL_STUB)) {
    return { mode: "stub", reason: "AAI_EVAL_STUB is set" };
  }
  if (creds.ready) return { mode: "live", reason: "a provider credential is set" };
  if (truthy(hostEnv.AAI_REQUIRE_EVAL)) {
    throw new Error(
      `AAI_REQUIRE_EVAL is set but this eval cannot run live: ${creds.reason}. ` +
        "Unset it to fall back to the scripted model, or supply the credential.",
    );
  }
  return { mode: "stub", reason: creds.reason ?? "no provider credential" };
}
