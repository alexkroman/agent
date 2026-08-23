// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 11.
 *
 * **Epoch 11 ADDS `WorkflowInputOf` and `WorkflowRunOf`.** Nothing was removed
 * and no signature narrowed, so epoch 10 is RETAINED and `./v10.ts` compiles
 * unchanged beside this file.
 *
 * They complete the set `WorkflowOutputOf` started, and the three travel
 * together because the three readers do: a BODY names the input, a PAGE names
 * the output, and a tool reporting on a run names the SNAPSHOT the two compose
 * into. Each reads the workflow's own declaration instead of restating it.
 *
 * `WorkflowInputOf` is the schema's OUTPUT type, and that is the distinction a
 * hand-written parameter gets wrong first: a field with a `.default()` is
 * OPTIONAL on the way in and REQUIRED after parsing, so a body annotated by hand
 * writes `limit?: number` and then re-implements the default with `??` — a
 * second copy of a value the schema already carries, free to disagree with it
 * and with nothing to report when it does. One template stated its six defaults
 * three times. And because `WorkflowBody` is contravariant in its parameter, a
 * body declaring a WIDER input is perfectly assignable, so nothing warns.
 *
 * `WorkflowRunOf<D>` is `WorkflowRunSnapshot<WorkflowOutputOf<D>>` — it NAMES a
 * composition rather than flattening one, so `isTerminal` still narrows through
 * it, which the two functions below are the evidence for.
 *
 * Both are erased by `import type`, so a `workflows/*.ts` body naming one
 * through a type-only import of `../agent.ts` drags no runtime cycle behind it.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { workflow } from "../../../index.ts";
import { type AgentClient, createAgentClient } from "../../../sdk/agent-client.ts";
import type { WorkflowInputOf, WorkflowRunOf, WorkflowSummary } from "../../../sdk/workflow.ts";
import type { StartOptions } from "../../../sdk/workflow-options.ts";
import { isTerminal, type WorkflowRunSnapshot } from "../../../sdk/workflow-run.ts";

/** Unchanged from epoch 10: one client for the whole agent, built once. */
const agent: AgentClient = createAgentClient({
  baseUrl: "https://agent.example/",
  token: process.env.AAI_WORKFLOW_API_TOKEN,
});

/** Unchanged from epoch 10: the guard is a TYPE guard and narrows `output`. */
export function describeRun(run: WorkflowRunSnapshot<{ text: string }> | undefined): string {
  if (!isTerminal(run)) return "still going";
  return run.status === "completed" ? run.output.text : run.status;
}

/** Unchanged from epoch 10: long-polling with no clamp of the caller's own. */
export async function waited(runId: string): Promise<WorkflowRunSnapshot | undefined> {
  return await agent.get(runId, { wait: 300_000 });
}

/** Unchanged from epoch 10: the option bag a caller passing a key builds. */
export const keyed: StartOptions = { key: "session_1" };

/** Unchanged from epoch 10: rendering a form from what `GET /workflows` listed. */
export function formTitle(summary: WorkflowSummary): string {
  return summary.description ?? summary.name;
}

/** The declaration the two new helpers read. Note the `.default(5)`. */
export const digest = workflow({
  description: "Digest a topic",
  input: z.object({ topic: z.string(), limit: z.number().default(5) }),
  async run(input) {
    await Promise.resolve();
    return { summary: `${input.topic} x${input.limit}` };
  },
});

/**
 * New at epoch 11. `limit` is `number` here, not `number | undefined` — the
 * default has already run — so the body has nothing left to re-implement.
 */
export function bodyInput(input: WorkflowInputOf<typeof digest>): string {
  return `${input.topic} (${input.limit})`;
}

/** And the caller's side: only the fields with no default are required. */
export const startedWith: WorkflowInputOf<typeof digest> = { topic: "voice", limit: 5 };

/**
 * New at epoch 11, and still the discriminated union: `isTerminal` narrows it
 * and `status === "completed"` makes `output` present, exactly as on the
 * uncomposed type.
 */
export function describeDigest(run: WorkflowRunOf<typeof digest>): string {
  if (!isTerminal(run)) return "still working on it";
  return run.status === "completed" ? run.output.summary : "that one did not finish";
}
