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
import { ADMIN_POOL_MAX, MAX_PLATFORM_DB_CONNECTIONS, SLUG_LOCK_POOL_MAX } from "./constants.ts";
import { fleetMaxContainers, platformDbBudget } from "./platform-db-capacity.ts";
import {
  platformDbConnectionsPerReplica,
  platformWorldConnections,
  QUEUE_NOTIFY_LISTEN,
} from "./platform-db-limits.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
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
  /**
   * EQUALITY, not `<=`, and the loose version cost a misleading production
   * warning for as long as it stood.
   *
   * `platformDbBudget()` returns `MAX_PLATFORM_DB_CONNECTIONS` verbatim, so any
   * gap between the constant and the product is claim no replica can ever open
   * — and the boot capacity check spends it anyway. Removing the per-tenant
   * term left the constant at 40 over a product of 30, and production announced
   * `budget OVERRUNS the instance by 17` where the real overrun was 7. A `<=`
   * assertion is what let that gap open silently; it also cannot fail when a
   * pool SHRINKS, which is the direction that hands back headroom the warning
   * has already promised away.
   */
  test("the autoscaler's ceiling times the per-replica pools IS the budget", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    const fleetTotal = maxContainers * platformDbConnectionsPerReplica();

    expect(
      fleetTotal,
      `MAX_CONTAINERS (${maxContainers}) x ${platformDbConnectionsPerReplica()} direct connections ` +
        `per replica = ${fleetTotal}, but the budget is ${MAX_PLATFORM_DB_CONNECTIONS}. ` +
        "These must be EQUAL: platformDbBudget() returns the constant verbatim, so a gap " +
        "is claim nothing can open and the boot capacity check overstates the overrun by it. " +
        "Raising either side needs the provisioned instance's max_connections checked first.",
    ).toBe(MAX_PLATFORM_DB_CONNECTIONS);
  });

  /**
   * The term `MAX_PLATFORM_DB_CONNECTIONS` excludes on a premise, and what
   * happens when the premise is false.
   *
   * With no `PLATFORM_POOLER_URL` the admin pool opens `ADMIN_POOL_MAX` DIRECT
   * session-mode backends per replica, which multiplex nothing. Production ran
   * that way: budget 40, plus 5 x 4 = 20 nobody added, against
   * `max_connections=60` with 20 already held by Supabase's own workers. Boot
   * printed `capacity ok — 0 spare` one line under the warning that named those
   * four per replica — both facts logged, neither compared — and the 53300
   * exhaustion they predict arrived with no warning.
   *
   * Asserted as an INEQUALITY against the pooled arm rather than as a literal:
   * the numbers are `MAX_CONTAINERS`'s and `ADMIN_POOL_MAX`'s to change, and what
   * must never come back is the budget being INDIFFERENT to how the pool is
   * routed.
   */
  test("a DIRECT admin pool is counted, because it multiplexes nothing", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    const direct = platformDbBudget({ MAX_CONTAINERS: String(maxContainers) });

    expect(
      direct,
      "with PLATFORM_POOLER_URL unset the admin pool is direct, so the fleet claim has to " +
        `grow by MAX_CONTAINERS (${maxContainers}) x ADMIN_POOL_MAX (${ADMIN_POOL_MAX}). A ` +
        "budget that ignores the routing is the one that printed `capacity ok` over a " +
        "20-connection overrun.",
    ).toBe(MAX_PLATFORM_DB_CONNECTIONS + maxContainers * ADMIN_POOL_MAX);
    expect(direct).toBeGreaterThan(platformDbBudget({ PLATFORM_POOLER_URL: "x:6543" }));
  });

  test("one replica is the honest default when no autoscaler declares a ceiling", () => {
    // `aai dev`, a unit test and a self-hosted `npm start` really are one
    // replica. Inventing a fleet would warn on every laptop; the deployment
    // that has one exports MAX_CONTAINERS from modal_deploy.py.
    expect(fleetMaxContainers({})).toBe(1);
    expect(fleetMaxContainers({ MAX_CONTAINERS: "5" })).toBe(5);
    // A value that is not a positive integer is a malformed declaration, not a
    // reason to guess high — and this is a capacity READING, which must never
    // be the thing that fails a boot.
    expect(fleetMaxContainers({ MAX_CONTAINERS: "" })).toBe(1);
    expect(fleetMaxContainers({ MAX_CONTAINERS: "nope" })).toBe(1);
    expect(fleetMaxContainers({ MAX_CONTAINERS: "0" })).toBe(1);
  });

  /**
   * The platform's own transient connections into app databases are left out of
   * the per-replica arithmetic on the grounds that a policy above them bounds
   * their number. That is only true if such a policy EXISTS, and for the wake
   * sweep it did not: `APP_DB_ADMIN_POOL_MAX`'s doc cited
   * `WORKFLOW_WAKE_MAX_PER_TICK`, which caps how many sandboxes a tick may BOOT
   * and is checked after the read phase has already connected to every
   * provisioned app. What actually held the budget was that the read loop
   * happened to be serial — a property of the loop shape, in a file whose one
   * paragraph on the subject told the next reader the bound was elsewhere.
   *
   * So the constant is asserted, and so is the citation: the exclusion in the
   * budget and the width in the sweep are one decision, and the failure mode is
   * that they stop referring to each other.
   */

  /**
   * The reader defaults to ONE replica when nothing declares a ceiling, which is
   * right for a laptop and silently wrong for the fleet — a deploy that stopped
   * exporting the constant would understate the claim by
   * `(MAX_CONTAINERS - 1) x ADMIN_POOL_MAX` and could print `capacity ok` over
   * the very overrun the export exists to surface. Nothing else in the repo
   * reads this env var, so nothing else would notice.
   */
  test("modal_deploy.py EXPORTS MAX_CONTAINERS, or the reader silently sees one", () => {
    expect(deployPy).toMatch(/"MAX_CONTAINERS":\s*str\(MAX_CONTAINERS\)/);
  });

  /**
   * The END STATE of the platform-owned world, asserted before it is wired.
   *
   * The world's pool and its streamer's `LISTEN` client are direct connections and
   * will join {@link platformDbConnectionsPerReplica} — but only in the change that
   * removes `APP_DB_CONNECTION_ALLOWANCE`, because the two terms do not fit
   * together and are not meant to: the allowance exists to give every workflow
   * agent its own six connections, which is exactly the cost this world removes.
   *
   * This asserts that the destination is reachable. Without it, "the world will fit
   * once tenant databases are gone" is a claim in a comment, and the branch that
   * finds out otherwise is the one that has already deleted them.
   */
  test("the fleet's direct connections fit the budget, world included", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    // `platformDbConnectionsPerReplica()` INCLUDES the world now — the allowance it
    // could not coexist with is gone — so this asserts the sum rather than
    // recomputing it, and a change to either term is caught here.
    const perReplica = platformDbConnectionsPerReplica();
    // Spelled out rather than called, so a term ADDED to the sum fails here and
    // has to be accounted for out loud. `QUEUE_NOTIFY_LISTEN` is the queue sweep's
    // dedicated `NOTIFY` connection: outside every pool, one per replica, and
    // counted for the same reason the world's `LISTEN` client is — a connection
    // outside a pool is still a backend on the instance.
    expect(perReplica).toBe(SLUG_LOCK_POOL_MAX + platformWorldConnections() + QUEUE_NOTIFY_LISTEN);
    const fleetDirect = maxContainers * perReplica;
    expect(
      fleetDirect,
      `MAX_CONTAINERS (${maxContainers}) x ${perReplica} = ${fleetDirect} direct once the ` +
        "direct. With no app-database allowance this has to fit " +
        `${platformDbBudget()} on its own — if it does not, the world's pool is too ` +
        "big or MAX_CONTAINERS is.",
    ).toBeLessThanOrEqual(platformDbBudget());
  });

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
    // `platform-db-limits.ts` for which locks decide that.
    expect(platformDbConnectionsPerReplica()).not.toBe(ADMIN_POOL_MAX + SLUG_LOCK_POOL_MAX);
    expect(platformDbConnectionsPerReplica()).toBeGreaterThan(SLUG_LOCK_POOL_MAX);
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
