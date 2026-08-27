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
  storageAppDbConnections,
} from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import {
  APP_DB_CONNECTION_ALLOWANCE,
  APP_DB_STORAGE_CONNECTION_LIMIT,
  APP_DB_WORKFLOW_CONNECTION_LIMIT,
  appDbClusterConnectionsPerReplica,
  appDbConnectionLimit,
  DEFAULT_APP_DB_TIER,
} from "./app-db-tier.ts";
import {
  ADMIN_POOL_MAX,
  APP_DB_ADMIN_POOL_MAX,
  APP_DB_TARGET_POOL_MAX,
  MAX_ACTIVE_APP_DATABASES,
  MAX_PLATFORM_DB_CONNECTIONS,
  SLUG_LOCK_POOL_MAX,
} from "./constants.ts";
import { fleetMaxContainers, platformDbBudget } from "./platform-db-capacity.ts";
import { platformDbConnectionsPerReplica, platformWorldConnections } from "./platform-db-limits.ts";

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
    const appTotal = APP_DB_CONNECTION_ALLOWANCE;

    expect(
      fleetDirect + appTotal,
      `MAX_CONTAINERS (${maxContainers}) x ${platformDbConnectionsPerReplica()} = ${fleetDirect} ` +
        `direct, plus an app-database allowance of ${appTotal} ` +
        `(${MAX_ACTIVE_APP_DATABASES} at the workflow tier's ` +
        `${APP_DB_WORKFLOW_CONNECTION_LIMIT}), is ${fleetDirect + appTotal} ` +
        `against a ${MAX_PLATFORM_DB_CONNECTIONS} ` +
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
    // Pooled: the admin pool multiplexes through Supavisor and costs the
    // instance nothing, so the claim is exactly the constant.
    const pooled = { PLATFORM_POOLER_URL: "postgresql://x@pool:6543/db" };
    expect(platformDbBudget(pooled)).toBe(MAX_PLATFORM_DB_CONNECTIONS);
    expect(fleetDirect + appTotal).toBeLessThanOrEqual(platformDbBudget(pooled));
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
  /**
   * The OTHER half of the per-tenant number, and the half that was uncounted.
   *
   * A tier's limit is a `connection limit` on a Postgres ROLE, so it
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
        `${APP_DB_BOOT_SPARE} spare, against a workflow-tier role limited to ` +
        `${APP_DB_WORKFLOW_CONNECTION_LIMIT}. ` +
        "Lower a term in aai/sdk/app-db-budget.ts, or raise the limit — which costs " +
        "MAX_ACTIVE_APP_DATABASES, per the test above.",
    ).toBeLessThanOrEqual(APP_DB_WORKFLOW_CONNECTION_LIMIT);
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
    expect(APP_DB_POOL_MAX).toBeLessThan(APP_DB_WORKFLOW_CONNECTION_LIMIT - APP_DB_WORLD_POOL_MAX);
  });

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
   * The two hand-set halves of the budget must agree, and this is what makes
   * lowering `MAX_CONTAINERS` a real trade instead of free money.
   *
   * `MAX_CONTAINERS` (deploy recipe) and `APP_DB_CONNECTION_ALLOWANCE`
   * (`app-db-tier.ts`) are both set by hand, and their sum is the whole claim.
   * Neither is derived from the other on purpose: a derived allowance would make
   * the assertion above a tautology — the budget compared against a number
   * defined as the budget minus something — so there would be nothing left to
   * check. Two hand-set numbers with this test between them is what makes raising
   * `MAX_CONTAINERS` back to 5 without giving the allowance back a RED SUITE
   * (5 x 4 + 28 = 48 > 40) rather than a silent overrun.
   *
   * It went 5 -> 3 on a measurement: one replica's broker held 23,000 rps at p99
   * 22ms with 256 concurrent and zero errors, flat from 32 concurrent up, so five
   * replicas was availability sizing and never throughput sizing. The 8
   * connections it freed moved onto the allowance — off a term that does not grow
   * with tenants and onto the one that does.
   */
  test("the fleet's own claim and the app allowance are ONE budget, split by hand", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    const fleetDirect = maxContainers * platformDbConnectionsPerReplica();

    // The split is exact: every connection the budget permits is accounted to
    // one side or the other. Slack here would be capacity nobody can spend.
    expect(
      fleetDirect + APP_DB_CONNECTION_ALLOWANCE,
      `MAX_CONTAINERS (${maxContainers}) x ${platformDbConnectionsPerReplica()} = ` +
        `${fleetDirect} for the fleet's own pools, plus ${APP_DB_CONNECTION_ALLOWANCE} ` +
        "for app databases. Lowering MAX_CONTAINERS frees connections for the term that " +
        "scales with TENANTS; raising it has to take them back from the allowance.",
    ).toBe(MAX_PLATFORM_DB_CONNECTIONS);

    // And the app COUNT is that allowance divided by the widest tier. Hand-set
    // (deriving it would make `app-db-tier.ts` and `constants.ts` mutually
    // importing), so it is asserted rather than trusted.
    expect(MAX_ACTIVE_APP_DATABASES).toBe(
      Math.floor(APP_DB_CONNECTION_ALLOWANCE / APP_DB_WORKFLOW_CONNECTION_LIMIT),
    );
  });

  /**
   * What lowering `MAX_CONTAINERS` bought, pinned so the claim in its comment
   * cannot rot: the WORKFLOW-tier count did not move, and the storage-tier one
   * did. 28 still floors to 2 against a limit of 10.
   */
  test("the freed budget bought storage-tier apps, not workflow-tier ones", () => {
    expect(Math.floor(APP_DB_CONNECTION_ALLOWANCE / APP_DB_WORKFLOW_CONNECTION_LIMIT)).toBe(2);
    expect(Math.floor(APP_DB_CONNECTION_ALLOWANCE / APP_DB_STORAGE_CONNECTION_LIMIT)).toBe(7);
  });

  /**
   * An extra placement cluster costs the PRIMARY's budget nothing, and the
   * arithmetic that said otherwise is why there were none.
   *
   * `platformDbConnectionsPerReplica` took an extra-cluster count and added
   * `APP_DB_TARGET_POOL_MAX` per cluster into a budget calibrated entirely
   * against one instance (60 `max_connections`, ~17 held by Supabase's own
   * workers). But `extraAppDbTargets` pools those connections against the extra
   * project's OWN url — a different instance — so they never compete with the
   * primary's Vault reads or slug locks. One extra cluster took the fleet claim
   * from 40 to 60 against a 40 budget, and `workflow-wake.ts` recorded the
   * resulting overrun as the reason sharding was unaffordable: the one mechanism
   * that relieves this ceiling, blocked by a miscount of it.
   */
  test("an extra APP_DB_URLS cluster costs the PRIMARY budget nothing", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    // The signature no longer accepts a cluster count at all, which is the
    // structural half of the fix: there is no way to spell the old sum.
    expect(platformDbConnectionsPerReplica()).toBe(SLUG_LOCK_POOL_MAX);
    expect(platformDbConnectionsPerReplica.length).toBe(0);

    // And the whole budget still fits WITH a cluster configured, which is the
    // property that was false before.
    const fleetDirect = maxContainers * platformDbConnectionsPerReplica();
    expect(fleetDirect + APP_DB_CONNECTION_ALLOWANCE).toBeLessThanOrEqual(
      MAX_PLATFORM_DB_CONNECTIONS,
    );
  });

  /**
   * The extra cluster's own claim, which is where those connections really land.
   *
   * Counted rather than dropped: an app-database cluster hosts no slug lock, no
   * Vault and no agents rows, so its ceiling is this pool times `MAX_CONTAINERS`
   * plus the entitlements of the apps placed on it. A cluster whose pool alone
   * outgrew a plausible instance would be the same class of bug one instance
   * over.
   */
  test("an extra cluster's own per-replica claim is its app-db pool", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    expect(appDbClusterConnectionsPerReplica()).toBe(APP_DB_TARGET_POOL_MAX);
    // No slug lock on a placement cluster — that is the primary's, fleet-wide.
    expect(appDbClusterConnectionsPerReplica()).toBeLessThan(
      platformDbConnectionsPerReplica() + APP_DB_TARGET_POOL_MAX,
    );
    expect(
      maxContainers * appDbClusterConnectionsPerReplica(),
      "a placement cluster's resident pools must leave room for the apps on it",
    ).toBeLessThan(MAX_PLATFORM_DB_CONNECTIONS);
  });

  /**
   * The two tiers, and the division that is the whole reason for having them.
   *
   * Each is asserted against the SDK's own sum for the guest it describes, since
   * the terms live there (`aai/sdk/app-db-budget.ts`) and a copy in this repo has
   * already gone stale once. The storage tier's sum is the interesting one: three
   * of the workflow tier's four terms exist only for the DevKit's world, which a
   * guest declaring no workflows never starts.
   */
  test("each tier's limit fits the guest it is for, and the allowance divides", () => {
    expect(appDbConnectionLimit("workflow")).toBe(APP_DB_WORKFLOW_CONNECTION_LIMIT);
    expect(appDbConnectionLimit("storage")).toBe(APP_DB_STORAGE_CONNECTION_LIMIT);
    expect(
      storageAppDbConnections() + APP_DB_BOOT_SPARE,
      "a storage-only guest holds its ctx.db handle and nothing else; the spare covers " +
        "the handover overlap exactly as it does at the workflow tier",
    ).toBeLessThanOrEqual(APP_DB_STORAGE_CONNECTION_LIMIT);
    // The tier is only worth having if it is genuinely cheaper.
    expect(APP_DB_STORAGE_CONNECTION_LIMIT).toBeLessThan(APP_DB_WORKFLOW_CONNECTION_LIMIT);
    // And what it buys is app databases on one instance: the same allowance
    // affords MAX_ACTIVE_APP_DATABASES workflow apps or more storage-only ones.
    // FLOORED, because the allowance no longer divides evenly: it is
    // `MAX_PLATFORM_DB_CONNECTIONS` minus the fleet's own claim (28 against a
    // limit of 10), and a partial app is not an app.
    expect(Math.floor(APP_DB_CONNECTION_ALLOWANCE / APP_DB_WORKFLOW_CONNECTION_LIMIT)).toBe(
      MAX_ACTIVE_APP_DATABASES,
    );
    expect(
      Math.floor(APP_DB_CONNECTION_ALLOWANCE / APP_DB_STORAGE_CONNECTION_LIMIT),
    ).toBeGreaterThan(MAX_ACTIVE_APP_DATABASES);
  });

  /**
   * The default tier is the WIDE one, and that is a compatibility property
   * rather than a preference.
   *
   * Every app provisioned before tiers existed carries the workflow limit, and a
   * stored meta with no `tier` reads as this default — so the value the parser
   * substitutes and the limit the role really has are the same number. Flipping
   * this constant would silently misdescribe every one of those roles.
   */
  test("the default tier is the one every existing app was provisioned at", () => {
    expect(DEFAULT_APP_DB_TIER).toBe("workflow");
    expect(appDbConnectionLimit(DEFAULT_APP_DB_TIER)).toBe(APP_DB_WORKFLOW_CONNECTION_LIMIT);
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
  test("the world fits a replica once the app-database allowance is gone", () => {
    const maxContainers = pyInt("MAX_CONTAINERS");
    const perReplica = SLUG_LOCK_POOL_MAX + platformWorldConnections();
    const fleetDirect = maxContainers * perReplica;
    expect(
      fleetDirect,
      `MAX_CONTAINERS (${maxContainers}) x ${perReplica} = ${fleetDirect} direct once the ` +
        "world is wired. With no app-database allowance this has to fit " +
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
