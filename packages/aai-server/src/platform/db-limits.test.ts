// Copyright 2026 the AAI authors. MIT license.
/**
 * Which connections a replica holds DIRECTLY. The fleet-wide arithmetic that
 * multiplies this by the autoscaler's ceiling is `db-budget.test.ts`'s.
 */

import { describe, expect, test } from "vitest";
import { ADMIN_POOL_MAX, SLUG_LOCK_POOL_MAX } from "../constants.ts";
import { platformDbConnectionsPerReplica } from "./db-limits.ts";

describe("platformDbConnectionsPerReplica", () => {
  test("only the SESSION-affine pool is counted as direct", () => {
    // Sharing one pool let a handful of concurrent distinct-slug deploys hold
    // every connection and starve Vault reads, workspace writes, and the
    // agents-row lookups the broker makes — on a replica that was otherwise
    // healthy. They add rather than overlap, so the budget must count both.
    // The two pools still EXIST separately — a held slug lock pins its
    // connection for a whole deploy while every admin statement is short, and
    // sharing one pool let a handful of concurrent deploys starve Vault reads.
    expect(ADMIN_POOL_MAX).toBeGreaterThan(0);
    expect(SLUG_LOCK_POOL_MAX).toBeGreaterThan(0);
    // ...but the ADMIN pool is not per-replica in the budget: it is
    // transaction-pooled, which genuinely multiplexes (measured: 4 client
    // connections cost 2-3 backends, fleet-wide rather than per replica). The
    // slug-lock pool and the DevKit world's are session-affine — an advisory lock
    // and a `LISTEN` both need connection affinity — so both count directly. See
    // `platform/db-limits.ts` for which locks decide that.
    expect(platformDbConnectionsPerReplica()).not.toBe(ADMIN_POOL_MAX + SLUG_LOCK_POOL_MAX);
    expect(platformDbConnectionsPerReplica()).toBeGreaterThan(SLUG_LOCK_POOL_MAX);
  });
});
