// Copyright 2026 the AAI authors. MIT license.
/**
 * Which key store an EMBEDDER gets — the two local arms, and nothing else.
 *
 * Split from `workflow-client.ts` when that file went over the 500-line cap, and
 * the seam is a real one rather than the nearest convenient cut: everything left
 * there CONSTRUCTS the client that becomes `ctx.workflows`, where this SELECTS a
 * backend, which is the concern `selectJournal` and `selectKeyStore`
 * (`workflow-runtime.ts`) own for the runs. It is also the shape
 * `_journal-claim.ts` was split at — a function whose argument is longer than
 * its body.
 *
 * @module
 */

import type { Db } from "@alexkroman1/aai/internal";
import {
  createMemoryKeyStore,
  createPostgresKeyStore,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";

/**
 * Build the key store an embedder holding a `Db` should use: that database, or
 * memory.
 *
 * The two LOCAL arms, and that is the whole of what this can decide. There is a
 * third — the platform's own index, which a DEPLOYED guest reaches over HTTP
 * (`workflow-keys-platform.ts`) — and it is deliberately not reachable from here:
 * it takes no argument an embedder could supply, being read out of the environment
 * the platform itself wrote, and reading that environment is a decision about which
 * deployment this is rather than about which `Db` the caller holds. `selectKeyStore`
 * in `workflow-runtime.ts` is where that decision lives, beside `selectJournal`,
 * which resolves the RUNS by the same preference and for the same reasons.
 *
 * So a deployed guest does not come through this function, and this signature is
 * unchanged for that reason as much as any: it is on this package's root barrel,
 * i.e. contracted, and widening it would oblige an epoch on the `keys` capability
 * to describe a platform arm no embedder can build.
 */
export function resolveKeyStore(db: Db | undefined): WorkflowKeyStore {
  return db ? createPostgresKeyStore(db) : createMemoryKeyStore();
}
