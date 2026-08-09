// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's DIRECT Postgres connection budget, held across the two files
 * that decide it: the pool sizes here and `MAX_CONTAINERS` in `modal_deploy.py`.
 *
 * Neither file refers to the other, and each number is individually reasonable
 * — which is exactly why this needs a test rather than a comment. The product
 * is what matters, these are session-mode connections with no pooler in front
 * of them (see MAX_PLATFORM_DB_CONNECTIONS), and the failure at the ceiling is
 * every platform read failing at once under load rather than anything
 * gradual.
 *
 * Same shape as `modal-image-inputs.test.ts`, which pins the other agreements
 * that span the TypeScript and the deploy recipe.
 *
 * The constants live in `constants.ts` rather than in `service-config.ts`,
 * which consumes them, and that placement is load-bearing HERE: v8 coverage
 * reports only the files a run loaded, so importing the 489-line composition
 * root from a unit test added ~370 uncovered lines to the package denominator
 * and dropped it below its floor — a test making the coverage gate fail by
 * existing, with nothing about it looking wrong.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ADMIN_POOL_MAX,
  APP_DB_TARGET_POOL_MAX,
  MAX_PLATFORM_DB_CONNECTIONS,
  platformDbConnectionsPerReplica,
  SLUG_LOCK_POOL_MAX,
} from "./constants.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const deployPy = readFileSync(path.join(REPO_ROOT, "packages/aai-server/modal_deploy.py"), "utf-8");

/**
 * Read a top-level `NAME = <int>` out of the deploy script. Throws rather than
 * asserting — an `expect` outside a test body reports as a suite-level crash
 * with no test name attached, and biome's `noMisplacedAssertion` rejects it.
 */
function pyInt(name: string): number {
  const raw = new RegExp(`^${name}\\s*=\\s*(\\d+)`, "m").exec(deployPy)?.[1];
  if (raw === undefined) throw new Error(`${name} not found in modal_deploy.py`);
  return Number(raw);
}

describe("platform database connection budget", () => {
  test("the autoscaler's ceiling times the per-replica pools fits the budget", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    const fleetTotal = maxContainers * platformDbConnectionsPerReplica();

    expect(
      fleetTotal,
      `MAX_CONTAINERS (${maxContainers}) x ${platformDbConnectionsPerReplica()} direct connections ` +
        `per replica = ${fleetTotal}, over the ${MAX_PLATFORM_DB_CONNECTIONS} budget. ` +
        "Raising either side needs the provisioned instance's max_connections checked first.",
    ).toBeLessThanOrEqual(MAX_PLATFORM_DB_CONNECTIONS);
  });

  test("extra APP_DB_URLS clusters are counted, because each pools its own", () => {
    // The budget is per REPLICA x containers, so a second placement cluster
    // adds MAX_CONTAINERS connections fleet-wide, not four. Adding one today
    // would exceed the budget — which is the point of counting it here rather
    // than discovering it when the cluster is added.
    expect(platformDbConnectionsPerReplica(1)).toBe(
      ADMIN_POOL_MAX + SLUG_LOCK_POOL_MAX + APP_DB_TARGET_POOL_MAX,
    );
    expect(platformDbConnectionsPerReplica(2)).toBe(
      platformDbConnectionsPerReplica(1) + APP_DB_TARGET_POOL_MAX,
    );
  });

  test("the admin and slug-lock pools stay SEPARATE", () => {
    // Sharing one pool let a handful of concurrent distinct-slug deploys hold
    // every connection and starve Vault reads, workspace writes, and the
    // agents-row lookups the broker makes — on a replica that was otherwise
    // healthy. They add rather than overlap, so the budget must count both.
    expect(platformDbConnectionsPerReplica()).toBe(ADMIN_POOL_MAX + SLUG_LOCK_POOL_MAX);
    expect(ADMIN_POOL_MAX).toBeGreaterThan(0);
    expect(SLUG_LOCK_POOL_MAX).toBeGreaterThan(0);
  });

  test("the connection string is direct, not a transaction-mode pooler", () => {
    // The budget only means anything while these are real backend connections.
    // If SUPABASE_DB_URL ever went through Supavisor's transaction mode the
    // arithmetic here would stop applying — but so would the advisory locks,
    // which is why boot refuses it outright rather than leaving it to a test.
    const source = readFileSync(path.join(import.meta.dirname, "platform-lock.ts"), "utf-8");
    expect(source).toContain("assertSessionModeUrl");
    expect(source).toMatch(/port === "6543"/);
  });
});
