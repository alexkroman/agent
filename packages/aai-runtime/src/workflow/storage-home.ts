// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a deployment's durable workflow state lives — decided ONCE, here.
 *
 * Three stores hang off this answer: the run journal (`selectJournal` in
 * `workflow/runtime.ts`), the correlation-key index (`selectKeyStore` beside it)
 * and the upload RECORD (`createUploadStore` in `workflow/uploads.ts`). Each used
 * to write the preference out for itself — `platformGuestOptions()`, then `db`,
 * then memory — and the three copies were kept equal by comments saying they
 * must be. A run whose journal went to the platform while its uploads went to a
 * directory is exactly what two copies of that order produced once. Now there is
 * one order, and every store is a `switch` over the home it returns.
 *
 * - **platform** — the guest was spawned by a platform (its pair is in THIS
 *   PROCESS's environment, see `platformGuestOptions`). First, even beside an
 *   author-supplied `DATABASE_URL`: a deployed guest's runs, keys and uploads
 *   belong beside its session state rather than split across two databases with
 *   the wake sweep able to see only one.
 * - **postgres** — the agent's own `DATABASE_URL`, which is what a self-hosted
 *   deployment has and the platform never provisions.
 * - **local** — neither. Runs and keys are in memory, uploads in the local data
 *   directory; the boot line SAYS so, because a durability tradeoff absent from
 *   the log reads as a bug.
 *
 * @module
 */

import type { Db } from "@alexkroman1/aai/internal";
import type { PlatformEndpoint } from "../platform-endpoint.ts";
import { platformGuestOptions } from "./platform-world.ts";

/**
 * The one answer to "where does this deployment's durable workflow state go".
 *
 * `D` is what stands for the agent's database: an open {@link Db} for the stores,
 * or its URL for `ownedSchemaUrl` (`agent-server-schemas.ts`), which asks the same
 * question before any pool exists — which database this deployment owes tables to.
 *
 * @internal
 */
export type StorageHome<D = Db> =
  | { kind: "platform"; platform: PlatformEndpoint }
  | { kind: "postgres"; db: D }
  | { kind: "local" };

/**
 * Resolve the home: platform, then the agent's database, then local.
 *
 * The platform pair is read from the process environment and never from the
 * agent's — an agent may set any `AAI_*` key as a secret, and under the tenant
 * spelling it would choose where its own journal is sent.
 *
 * @internal
 */
export function resolveStorageHome<D>(db: D | undefined): StorageHome<D> {
  const platform = platformGuestOptions();
  if (platform) return { kind: "platform", platform };
  if (db !== undefined) return { kind: "postgres", db };
  return { kind: "local" };
}

/**
 * Whether state in this home outlives the process holding it.
 *
 * @internal
 */
export function isDurableHome(home: StorageHome<unknown>): boolean {
  return home.kind !== "local";
}
