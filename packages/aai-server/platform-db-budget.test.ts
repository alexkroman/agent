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
import {
  APP_DB_BOOT_SPARE,
  APP_DB_POOL_MAX,
  APP_DB_WORLD_POOL_MAX,
  APP_DB_WORLD_WORKER_CONCURRENCY,
  guestAppDbConnections,
} from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { WORKFLOW_WAKE_READ_CONCURRENCY } from "./_workflow-wake-read.ts";
import {
  ADMIN_POOL_MAX,
  APP_DB_ADMIN_POOL_MAX,
  APP_DB_CONNECTION_LIMIT,
  APP_DB_TARGET_POOL_MAX,
  MAX_ACTIVE_APP_DATABASES,
  MAX_PLATFORM_DB_CONNECTIONS,
  platformDbConnectionsPerReplica,
  SLUG_LOCK_POOL_MAX,
} from "./constants.ts";
import { platformDbBudget } from "./platform-db-capacity.ts";

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

  /**
   * The whole budget, and the one this file was missing: the platform's own
   * pools PLUS the app databases they cannot reach. `platformDbBudget()` is what
   * the boot-time check compares against the real instance, so the two cannot
   * disagree about what is claimed.
   *
   * This is the assertion that makes MAX_CONTAINERS and the tenant count compete
   * in the open. They always competed for the same `max_connections`; only one
   * of them was counted.
   */
  test("the fleet's direct pools AND the app databases fit the budget together", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    const fleetDirect = maxContainers * platformDbConnectionsPerReplica();
    const appTotal = MAX_ACTIVE_APP_DATABASES * APP_DB_CONNECTION_LIMIT;

    expect(
      fleetDirect + appTotal,
      `MAX_CONTAINERS (${maxContainers}) x ${platformDbConnectionsPerReplica()} = ${fleetDirect} ` +
        `direct, plus ${MAX_ACTIVE_APP_DATABASES} app databases x ${APP_DB_CONNECTION_LIMIT} = ` +
        `${appTotal}, is ${fleetDirect + appTotal} against a ${MAX_PLATFORM_DB_CONNECTIONS} ` +
        "budget. These two terms compete: lower MAX_CONTAINERS to buy app databases, or " +
        "provision a bigger instance / shard with APP_DB_URLS to buy both.",
    ).toBeLessThanOrEqual(MAX_PLATFORM_DB_CONNECTIONS);
    // The runtime check must claim exactly what this test allows, or a green
    // suite would sit beside a warning at boot (or, worse, silence at boot
    // beside a red suite). "Exactly what this test allows" is the ceiling the
    // assertion above compares against — `MAX_PLATFORM_DB_CONNECTIONS`, app
    // databases INCLUDED. This line used to read `+ appTotal`, which is the
    // double count `platformDbBudget` carried: it demanded the runtime claim be
    // `appTotal` larger than the bound this very test enforces, and so it was the
    // green suite sitting beside the warning at boot rather than the guard
    // against it.
    expect(platformDbBudget()).toBe(MAX_PLATFORM_DB_CONNECTIONS);
    expect(fleetDirect + appTotal).toBeLessThanOrEqual(platformDbBudget());
  });

  /**
   * The pooler routing still has to exist — it is what keeps a per-app
   * connection off the DIRECT budget and under Supavisor's own limits.
   *
   * But it is NOT why app databases may be left out of the arithmetic, and for a
   * long time this file said it was. The pooler here is Supavisor in SESSION
   * mode, mandatory for the Workflow DevKit (transaction mode breaks
   * graphile-worker's prepared statements and world-postgres's LISTEN), and
   * session mode multiplexes NOTHING: one client connection is one backend on
   * the instance. So the routing changes which limits apply, never how many
   * connections exist — which is why the test above counts them.
   *
   * A TEXT scan, because the property is "the routing exists", and the alternative
   * (asserting a URL) would pass against a helper nothing calls.
   */
  test("per-app connections are POOLED, which bounds them without hiding them", () => {
    // `app-db-url.ts` owns how an app database is ADDRESSED; the resolver that
    // decides whether a pooler is used at all lives with the other connection
    // settings. Both are named here because the exclusion above depends on the
    // two of them together — and if either file moves, this fails rather than
    // quietly scanning nothing.
    const url = readFileSync(path.join(REPO_ROOT, "packages/aai-server/app-db-url.ts"), "utf-8");
    expect(url).toContain("withPoolerHost");
    // Applied on BOTH app-database URLs: the tenant's own (`ctx.db`) and the
    // platform's way in (the wake sweep, the usage read).
    expect(url).toMatch(/appDbConnectionUrl[\s\S]{0,200}withPoolerHost/);
    expect(url).toMatch(/appDbAdminUrl[\s\S]{0,300}withPoolerHost/);
    expect(
      readFileSync(
        path.join(REPO_ROOT, "packages/aai-server/platform-connection-config.ts"),
        "utf-8",
      ),
    ).toContain("APP_DB_POOLER_URL");
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
  test("the wake sweep's app-db read width is a declared bound, and the budget cites it", () => {
    // Fleet-wide rather than per-replica: the read phase runs under a
    // transaction-scoped advisory lock, so one replica sweeps per tick.
    expect(WORKFLOW_WAKE_READ_CONCURRENCY).toBeGreaterThanOrEqual(1);
    // Bounded against the nearest COUNTED term rather than against the budget
    // total, which `platformDbBudget()` returns as the whole
    // `MAX_PLATFORM_DB_CONNECTIONS` (that is the point of it — see its doc). A
    // whole placement cluster's per-replica pool is the right comparison: these
    // transients are the same kind of connection, and one leader's pass must not
    // cost more of the instance than a cluster's resident pool does.
    expect(
      WORKFLOW_WAKE_READ_CONCURRENCY,
      "a leader's wake pass must not out-consume a placement cluster's own pool",
    ).toBeLessThanOrEqual(APP_DB_TARGET_POOL_MAX);

    // The citation, read out of the doc block that PRECEDES the exclusion —
    // anywhere-in-the-file would pass on the constant's own definition below it.
    const constants = readFileSync(
      path.join(REPO_ROOT, "packages/aai-server/constants.ts"),
      "utf-8",
    );
    const declaredAt = constants.indexOf("export const APP_DB_ADMIN_POOL_MAX");
    expect(declaredAt).toBeGreaterThan(0);
    const doc = constants.slice(0, declaredAt);
    expect(doc.lastIndexOf("/**")).toBeGreaterThan(0);
    expect(doc.slice(doc.lastIndexOf("/**"))).toContain("WORKFLOW_WAKE_READ_CONCURRENCY");

    // And the width is enforced by a bounded RUNNER that reads the constant,
    // rather than by the loop happening to be serial — the distinction this whole
    // test exists for. (A worker pool and not a semaphore: with every candidate
    // asking for a slot at once, a bounded acquire measures its deadline from t=0
    // and silently drops the tail of a large fleet. `readHints`'s own doc has it.)
    const read = readFileSync(
      path.join(REPO_ROOT, "packages/aai-server/_workflow-wake-read.ts"),
      "utf-8",
    );
    expect(read).toContain("readConcurrency");
    expect(read).toContain("readHints");
  });

  /**
   * The OTHER half of the per-tenant number, and the half that was uncounted.
   *
   * `APP_DB_CONNECTION_LIMIT` is a `connection limit` on a Postgres ROLE, so it
   * is not a target the guest aims at — it is a refusal, and the guest's own
   * consumers are what add up to it. Those consumers live in the SDK
   * (`aai/sdk/app-db-budget.ts`), which is why this reaches across the package
   * boundary rather than restating them: a copy in this repo has already gone
   * stale once, counting four consumers where a real guest had six, and the
   * failure it produced was `too many connections for role "app_…"` from
   * whichever consumer asked last.
   *
   * The ceiling plus the SPARE, not the ceiling alone: the DevKit migrates on
   * boot, and a replaced sandbox is briefly alive beside its replacement — which
   * is the overlap the wild failure came out of. A ceiling that exactly filled
   * the limit would leave neither any room.
   */
  test("one guest's connection ceiling fits inside the role's limit", () => {
    expect(
      guestAppDbConnections() + APP_DB_BOOT_SPARE,
      `a workflow guest may hold ${guestAppDbConnections()} connections, plus ` +
        `${APP_DB_BOOT_SPARE} spare, against a role limited to ${APP_DB_CONNECTION_LIMIT}. ` +
        "Lower a term in aai/sdk/app-db-budget.ts, or raise the limit — which costs " +
        "MAX_ACTIVE_APP_DATABASES, per the test above.",
    ).toBeLessThanOrEqual(APP_DB_CONNECTION_LIMIT);
  });

  /**
   * graphile-worker holds one connection out of the pool it is handed for the
   * life of the process, to `LISTEN` for `jobs:insert` (verified in 0.16.6:
   * `pgPool.connect(listenForChanges)`). So step concurrency set to the pool size
   * means the last worker is waiting on a pool that cannot give it anything —
   * which reads as a hung run, the exact symptom the old comment cited as the
   * reason for setting them equal.
   */
  test("step concurrency leaves the world pool a slot for its own LISTEN", () => {
    expect(APP_DB_WORLD_WORKER_CONCURRENCY).toBe(APP_DB_WORLD_POOL_MAX - 1);
    // And the app's own handle is not the whole remainder: the budget has to fit
    // the world's pool, its streamer LISTEN and the presence lock beside it.
    expect(APP_DB_POOL_MAX).toBeLessThan(APP_DB_CONNECTION_LIMIT - APP_DB_WORLD_POOL_MAX);
  });

  test("extra APP_DB_URLS clusters are counted, because each pools its own", () => {
    // The budget is per REPLICA x containers, so a second placement cluster
    // adds MAX_CONTAINERS connections fleet-wide, not four. Adding one today
    // would exceed the budget — which is the point of counting it here rather
    // than discovering it when the cluster is added.
    expect(platformDbConnectionsPerReplica(1)).toBe(SLUG_LOCK_POOL_MAX + APP_DB_TARGET_POOL_MAX);
    expect(platformDbConnectionsPerReplica(2)).toBe(
      platformDbConnectionsPerReplica(1) + APP_DB_TARGET_POOL_MAX,
    );
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
    // ...but only the SLUG-LOCK pool is direct, so only it is PER-REPLICA in the
    // budget. The admin pool is transaction-pooled, which genuinely multiplexes
    // (measured: 4 client connections cost 2-3 backends, fleet-wide rather than
    // per replica). Per-app connections are session-pooled, which does not — they
    // are counted as a whole-fleet term instead, above. See
    // `platformDbConnectionsPerReplica` for which locks decide that.
    expect(platformDbConnectionsPerReplica()).toBe(SLUG_LOCK_POOL_MAX);
    expect(platformDbConnectionsPerReplica()).not.toBe(ADMIN_POOL_MAX + SLUG_LOCK_POOL_MAX);
    expect(APP_DB_ADMIN_POOL_MAX).toBeGreaterThan(0);
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
