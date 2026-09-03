// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:workflow` epoch 1.
 *
 * A host ASSEMBLING the workflow client's options — which is what this
 * capability publishes, and the shape a self-hosted deployment builds when it
 * serves `/workflows/*` itself. Written the way it was authored at epoch 1, and
 * it must keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 ADDED `ensureWorkflowJournalSchema` — the DDL for the durable-run
 * journal's tables. Adding a name breaks nothing that did not name it, which is
 * what makes this a retain rather than a drop.
 *
 * It is worth recording WHY it was added, because the absence was the bug: the
 * applier behind it existed from the start with no production caller, so a
 * self-hosted deployment with a `DATABASE_URL` logged `runStore: "postgres"` at
 * boot and then died on its first run with `42P01 relation
 * "aai_workflow_runs" does not exist`. The boot line claimed durable and nothing
 * was. `ensureSessionStateSchema` is public for exactly the same reason one
 * table set over — `server.mjs` ships to a user and may import only this
 * surface — and this is the second time that rule was the missing half.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 */

import {
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_INPUT_BYTES,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowClientOptions,
} from "../../../runtime-barrel.ts";

/** ── EDIT: where this deployment's runs live. ───────────────────────────── */
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * The route the workflow HTTP API is served under, and the key that CLOSES it.
 *
 * Both from the package rather than spelled here: the prefix is half of one wire
 * — a page builds every URL from `location` and the server has to answer on the
 * same path — and the token env var is what an operator sets to stop
 * `/workflows/*` being open. A literal for either is a silent mismatch.
 */
export const apiPrefix: string = WORKFLOW_API_PREFIX;
export const apiToken: string | undefined = process.env[WORKFLOW_API_TOKEN_ENV];

/**
 * ── EDIT: the options this host hands the workflow client. ────────────────
 *
 * Assembled rather than passed to anything here, which is a real limitation of
 * this capability and not a gap in the example: `WorkflowClientOptions` is
 * contracted and `createWorkflowClient` is on `/internal`, so a template can
 * build the bag and not hand it over. The runtime's own guide records that
 * asymmetry as a finding.
 */
export function clientOptions(
  bag: Pick<WorkflowClientOptions, "workflows" | "keys" | "wdk" | "logger">,
): WorkflowClientOptions {
  return {
    ...bag,
    // Absent, `publicWebhookUrl` throws rather than minting a `localhost` URL a
    // third party cannot reach.
    publicUrl: process.env.PUBLIC_URL,
  };
}

/** ── EDIT: how many runs a listing asks for. ────────────────────────────── */
export const listingLimit: number = DEFAULT_WORKFLOW_FIND_LIMIT;

/**
 * The largest input a run may be started with.
 *
 * Read rather than restated: a host that validates against its own number
 * accepts a payload the API then refuses, which surfaces as a start that fails
 * for no reason the caller can see.
 */
export const maxInputBytes: number = MAX_WORKFLOW_INPUT_BYTES;

/**
 * Create the journal's tables, when this deployment owns its database.
 *
 * The name epoch 2 added. A no-op for a deployment with no `DATABASE_URL`: its
 * runs live in memory and there is nothing to create.
 */
export async function ensureSchema(): Promise<void> {
  if (!DATABASE_URL) return;
  const { ensureWorkflowJournalSchema } = await import("../../../runtime-barrel.ts");
  await ensureWorkflowJournalSchema({ url: DATABASE_URL, logger: console });
}
