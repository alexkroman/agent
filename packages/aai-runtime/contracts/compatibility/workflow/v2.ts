// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-2 template: `aai-runtime:workflow`. The request contract a host applies
 * at the edge of the workflow HTTP API, as it was written at epoch 2.
 *
 * **Epoch 2 removes nothing and adds nothing.** The export list is byte-identical
 * to epoch 1's, and epoch 1 is RETAINED: `./v1.ts` — the full host starter, the
 * `RunStore`, the nine-method `WdkAdapter`, the options bag and the guards — is
 * still the file to copy, and it compiles unchanged beside this one. What moved
 * is one line of PROVENANCE in the rollup: `WORKFLOW_API_PREFIX` reaches this
 * package from `@alexkroman1/aai/internal` rather than
 * `@alexkroman1/aai/workflow-api`, because the prefix is the SERVER's half of
 * that API and its only importers were this package and the studio's docs page.
 * A host that takes the constant from `@alexkroman1/aai-runtime` — which is
 * every host, since that is what this contract publishes — sees nothing at all,
 * and this file is the evidence for that claim.
 *
 * FROZEN. It must keep compiling against current source for as long as epoch 2
 * is supported, so `pnpm typecheck` is the backward-compatibility gate and an
 * error here IS the finding. Do not edit it to make an error go away: an API
 * that has to change gets a NEW epoch carrying a new template. The imports are
 * relative source paths because nothing ships this file; in your copy they are
 * `@alexkroman1/aai-runtime`.
 */

import {
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_INPUT_BYTES,
  type WdkRunRecord,
  type WdkStreamOptions,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowClientOptions,
} from "../../../runtime-barrel.ts";

/**
 * Does this request belong to the workflow API at all? One prefix, resolved
 * from the constant rather than restated — a host that writes `/workflows`
 * itself drifts from the client that builds the URL.
 */
export const claimsRoute = (path: string): boolean =>
  path === WORKFLOW_API_PREFIX || path.startsWith(`${WORKFLOW_API_PREFIX}/`);

/**
 * The bearer token a host checks against. The NAME is the contract, not the
 * value: the CLI, the platform and a self-hosted server all read the same
 * variable, so a host that spells its own cannot be reached by the shipped
 * clients.
 */
export const configuredToken = (): string | undefined => process.env[WORKFLOW_API_TOKEN_ENV];

/** A `?limit=` a route accepts, defaulted and capped by the shipped numbers. */
export function findLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WORKFLOW_FIND_LIMIT;
  return Math.min(Math.max(1, Math.trunc(requested)), MAX_WORKFLOW_FIND_LIMIT);
}

/**
 * The input cap, applied to the SERIALIZED body — a character count would pass
 * a multi-byte payload at up to three times the budget.
 */
export const inputTooLarge = (body: string): boolean =>
  Buffer.byteLength(body, "utf8") > MAX_WORKFLOW_INPUT_BYTES;

/** What a host hands back for one run, and how a route reads its outcome. */
export function outcome(record: WdkRunRecord): string {
  return record.status === "completed" ? "done" : record.status;
}

/** The stream options a `GET …/runs/:id/stream` forwards to the adapter. */
export const fromStart: WdkStreamOptions = { startIndex: 0 };

/**
 * The options bag a host assembles before any workflow route can serve. Every
 * member but `publicUrl` is required, which is the shape epoch 1's template
 * builds — see `./v1.ts` for where each one comes from.
 */
export const clientOptions = (
  parts: Omit<WorkflowClientOptions, "publicUrl">,
  publicUrl: string,
): WorkflowClientOptions => ({ ...parts, publicUrl });
