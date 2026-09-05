// Copyright 2026 the AAI authors. MIT license.
/**
 * What a settled walk makes the run — and, when the workflow declared an
 * `output` schema, whether the body really produced what it promised.
 *
 * `WorkflowDef.output` is optional and most workflows declare none, in which
 * case this is a pass-through and nothing about a run changes. What it buys a
 * workflow that does declare one is that `WorkflowOutputOf<typeof def>` — which
 * a page reads as `run.output.text` — stops being an unchecked CLAIM. That
 * value crosses a durable journal, the typed-JSON storage codec (whose own doc
 * carries a type-confusion history: an author's `{ __type: … }` object came back
 * as a `Uint8Array`) and an HTTP hop to a browser, and until this nothing
 * anywhere compared it against what the workflow says it produces.
 *
 * ## A missed schema is a FAILED run
 *
 * The alternative — complete the run, log a warning — is the one shape that
 * cannot be right: the snapshot would say `completed` while carrying an output
 * the workflow's own declaration denies, and every reader downstream is typed
 * against that declaration. A run that cannot honestly report `completed`
 * failed, and recording it that way is what lets a caller retry, alert, or read
 * the reason. The message names the workflow and the issues, because the reader
 * is whoever wrote the body and the question is always which property
 * disagreed.
 *
 * ## A validator that THROWS fails the run too, and that is not the same call
 *
 * A `~standard.validate` may throw rather than answer issues — a vendor bug, or
 * a refinement that threw on the shape it was handed. That is a fact about the
 * DECLARATION and it is identical on every delivery, so propagating it would
 * have the queue redeliver a run whose body already completed until the
 * abandonment budget ran out, spending a walk each time to reach the same
 * throw. A run that fails naming the schema is strictly more useful.
 *
 * ## A failure of the JOURNAL is still not a failure of the RUN
 *
 * That rule (`JOURNAL-CLAUDE.md`) is upheld structurally here rather than by
 * care: nothing in this module touches the store, and the engine calls it
 * BEFORE the `setStatus` that records what it decided. So a database blip is
 * still a rejected delivery the queue retries, and the only thing this module
 * can turn into a failed run is the value the body returned.
 *
 * And nothing re-validates on the way back OUT: `toSnapshot`
 * (`workflow-client.ts`) is called on every poll, including a browser reload of
 * a long-finished run, and a parse there would be a hot path for a value
 * already checked once at the only moment it could have changed.
 */

import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { WorkflowDef } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "./runtime-config.ts";
import type { ReplayOutcome } from "./workflow-replay.ts";

/** The terminal status a settled walk resolves to, and what to write with it. */
export type SettledRunState = {
  readonly status: "completed" | "failed";
  readonly patch: { output?: unknown; error?: { message: string } };
};

/**
 * Decide what a settled walk makes the run: `completed` with an output, or
 * `failed` with a message.
 *
 * `outcome` excludes `suspended` — a suspended walk is not settled and writes no
 * status at all, which is the engine's business rather than this module's.
 */
export async function settleRunOutcome(
  def: WorkflowDef | undefined,
  workflow: string,
  runId: string,
  outcome: Extract<ReplayOutcome, { kind: "completed" | "failed" }>,
  logger: Logger,
): Promise<SettledRunState> {
  if (outcome.kind === "failed") return { status: "failed", patch: { error: outcome.error } };
  const checked = await checkRunOutput(def?.output, workflow, outcome.output);
  if (!checked.ok) {
    // Logged as well as recorded: the run's `error` reaches whoever polls it,
    // and this reaches whoever is reading the agent's log to find out why a
    // workflow that "works" keeps failing.
    logger.warn?.("Workflow output rejected by its declared schema", {
      runId,
      workflow,
      reason: checked.message,
    });
    return { status: "failed", patch: { error: { message: checked.message } } };
  }
  return { status: "completed", patch: { output: checked.value } };
}

/**
 * The verdict on one run's output: the value to journal, or why it may not be.
 *
 * `value` rather than the caller's own `output`, because a schema PARSES — a
 * `.default()` fills in, a zod object strips an unknown key — and what a caller
 * reads back has to be what the declaration describes. Same rule as `start()`,
 * which journals the parsed input rather than the payload it was handed. With
 * no schema declared it is the body's return unchanged.
 */
type RunOutputCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * Check `output` against a workflow's declared output schema.
 *
 * A workflow with no `output` accepts anything its body returns, matching both
 * `tool()` and the input half of `WorkflowClient.start`.
 */
async function checkRunOutput(
  schema: WorkflowDef["output"],
  workflow: string,
  output: unknown,
): Promise<RunOutputCheck> {
  if (!schema) return { ok: true, value: output };
  try {
    const result = await schema["~standard"].validate(output);
    if (result.issues) {
      return {
        ok: false,
        message: `Workflow "${workflow}" returned an output its declared schema rejects: ${formatSchemaIssues(result.issues)}`,
      };
    }
    return { ok: true, value: result.value };
  } catch (err: unknown) {
    return {
      ok: false,
      message: `Workflow "${workflow}" could not validate its output: ${errorMessage(err)}`,
    };
  }
}
