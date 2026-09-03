// Copyright 2026 the AAI authors. MIT license.
/**
 * What the platform's two Postgres pools are CONSTRUCTED with.
 *
 * **The WIRING half of the reserved-query bound; `aai-runtime`'s
 * `postgres-db.test.ts` is the BEHAVIOUR half — do not merge them, and neither
 * is a duplicate of the other.** That file proves the option works: a
 * reservation stalls forever without `reservedQueryTimeoutMs` and rejects with
 * `QUERY_TIMEOUT` once it is set. It cannot see whether anything PASSES it, and
 * for the admin pool that is the whole protection — every guest platform route
 * runs its work on a reservation from here (`_platform-route.ts`'s
 * `withReserved`) and takes no advisory lock, so with the option absent four
 * hung reads on a silently partitioned database exhaust `ADMIN_POOL_MAX` and
 * every other platform read on the replica queues behind them. Deleting the one
 * line in `service-config.ts` reopened that hole with the entire repository
 * green, which is what this spec is for.
 *
 * The negative assertion carries the same weight as the positive one: a future
 * "set it everywhere" tidy-up would bound the slug-lock pool's reservation,
 * whose whole job is holding `pg_advisory_lock` across a deploy — so the bound
 * would abort deploys, in production only, with nothing failing here.
 *
 * The `postgres` module is never reached: `createPostgresDb` is mocked, so no
 * connection is opened and what this spec reads is the options object.
 *
 * The SECOND section is the `LISTEN`'s own handle, and it is the one assertion
 * this file makes about ROUTING rather than about deadlines: a `LISTEN` is
 * session state, so subscribing through the transaction-mode pooler established
 * a subscription that received nothing, with the poll interval covering for it —
 * pure latency, no error anywhere. Nothing pinned which connection the
 * subscription opened on, so the fix has to be pinned by the member: `listen`
 * reaches the session-mode URL while `reserve` reaches the pooler, asserted from
 * the handles themselves rather than from the options list.
 *
 * The THIRD covers `buildServiceConfig`'s three AUTH-shaped call sites,
 * all of which fail in the same direction — the platform ACCEPTING a request it
 * should refuse — and all of which were guarded by nothing. Each is asserted as
 * DERIVED rather than by the shape of the argument: the edit to be afraid of is
 * a literal `true` in place of `isLocalDev(env)` or `hasPlatformDb(env)`, which
 * an assertion on the call's shape passes straight over. So each is proved by
 * flipping the environment and watching what the call site does.
 */

import type { CloseableDb, CreatePostgresDbOptions } from "@alexkroman1/aai-runtime";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ADMIN_POOL_MAX, SLUG_LOCK_POOL_MAX } from "./constants.ts";
import { GUEST_TOKEN_SECRET_ENV } from "./guest-token.ts";
import {
  PLATFORM_DB_CONNECT_TIMEOUT_SECONDS,
  PLATFORM_DB_QUERY_TIMEOUT_MS,
  PLATFORM_DB_RESERVE_TIMEOUT_MS,
} from "./platform-db-errors.ts";
import { QUEUE_NOTIFY_LISTEN } from "./platform-db-limits.ts";
import type { AdminDb } from "./platform-lock.ts";
import { buildPlatformDb, buildServiceConfig } from "./service-config.ts";
import { captureLogs } from "./test-utils.ts";

/** Every pool `buildPlatformDb` built, in construction order. */
const pools: CreatePostgresDbOptions[] = [];

/**
 * Which handle a `reserve()` or a `listen()` actually reached, by that handle's
 * URL.
 *
 * The options list cannot answer this. `AdminDb` is composed from TWO handles
 * now — `reserve` off the admin pool, `listen` off a session-mode handle of its
 * own — and reading the third pool's `url` only proves such a pool was BUILT,
 * not that the subscription is the thing that goes there. So the fake records
 * per call, which is the claim: a `listen` that reached the pooler URL is the
 * bug, and it is invisible in production (the subscription establishes and
 * receives nothing).
 */
const calls: { kind: "listen" | "reserve"; url: string }[] = [];

/**
 * A pool handle that opens nothing. The boot-time consumers (Vault, the pg_cron
 * scheduling, the capacity read) run against it and see no rows, which is all
 * this spec needs — it reads the OPTIONS, never a row.
 *
 * It knows the `url` it was built from so `calls` can name the handle rather
 * than merely counting.
 */
function inertDb(url: string): CloseableDb {
  return {
    query: () => Promise.resolve([]),
    reserve: () => {
      calls.push({ kind: "reserve", url });
      return Promise.resolve({ query: () => Promise.resolve([]), release: () => undefined });
    },
    listen: () => {
      calls.push({ kind: "listen", url });
      return Promise.resolve(() => undefined);
    },
    close: () => Promise.resolve(),
  };
}

vi.mock("@alexkroman1/aai-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@alexkroman1/aai-runtime")>()),
  createPostgresDb: (opts: CreatePostgresDbOptions) => {
    pools.push(opts);
    return inertDb(opts.url);
  },
}));

// The Realtime client is not this spec's subject and is the one binding here
// that would reach the network on construction. The in-process emitter is the
// same `PlatformEvents`, so nothing is faked beyond the transport.
vi.mock("./realtime-events.ts", async () => {
  const { createMemoryPlatformEvents } = await import("./platform-events.ts");
  return { createRealtimePlatformEvents: () => createMemoryPlatformEvents().events };
});

/** A direct SESSION-mode string — what `assertSessionModeUrl` demands. */
const DIRECT_URL = "postgres://postgres:pw@127.0.0.1:54322/postgres";
/** Supavisor in TRANSACTION mode — the only shape `PLATFORM_POOLER_URL` takes. */
const POOLER_URL = "postgres://postgres:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

function platformEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SUPABASE_DB_URL: DIRECT_URL,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
    AAI_PUBLIC_ORIGIN: "https://aai.example",
    ...extra,
  };
}

/**
 * Everything `buildServiceConfig` needs beyond the pools, on the PLATFORM tier.
 *
 * The bucket is what Supabase Storage and the upload-window store require
 * together; the backend is pinned to `microsandbox` so nothing here constructs a
 * Modal client, which is not this spec's subject.
 */
function serviceEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return platformEnv({
    SUPABASE_STORAGE_BUCKET: "blobs",
    // Browser-session auth. Required on this tier rather than optional, and
    // found BY this spec: `createStudioAuthFromEnv` refuses to serve no-auth dev
    // tokens against real stores, where any caller could claim any user id and
    // read that account's stored AssemblyAI key.
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_anon",
    SANDBOX_BACKEND: "microsandbox",
    ...extra,
  });
}

/** The MEMORY tier — no `SUPABASE_DB_URL`, so every store is in-process. */
function memoryEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { SANDBOX_BACKEND: "microsandbox", ...extra };
}

/** A Supabase PUBLISHABLE (anon-authority) key — the definite-wrong form. */
const PUBLISHABLE_KEY = "sb_publishable_deadbeef";

/**
 * The two pools, told apart by `max` — which is what this file's own note said
 * to do "if either constant ever moves".
 *
 * It moved: `ADMIN_POOL_MAX` is 16 against `SLUG_LOCK_POOL_MAX`'s 4, so the
 * reading by CONSTRUCTION order this used to take is no longer the only one
 * available — and order was always the weaker premise, being a fact about
 * `buildPlatformDb`'s statement sequence rather than about either pool. The
 * timeouts still cannot serve: they are the subject of the tests below, so
 * reading them here would be circular.
 *
 * The identification is ASSERTED rather than assumed — `expectOne` throws when
 * the `max` it names does not appear exactly once — so a future value that
 * collapses the two back together fails here, naming the collision, instead of
 * silently handing every test below the same pool twice.
 *
 * THROWS rather than asserting, so the helper is legal outside a test body.
 */
function builtPools(): { admin: CreatePostgresDbOptions; slugLock: CreatePostgresDbOptions } {
  if (pools.length !== 2) {
    throw new Error(`expected exactly two platform pools, got ${pools.length}`);
  }
  const expectOne = (max: number, which: string): CreatePostgresDbOptions => {
    const matches = pools.filter((pool) => pool.max === max);
    const only = matches[0];
    if (!only || matches.length !== 1) {
      throw new Error(
        `expected exactly one ${which} pool with max ${max}, got ${matches.length} — ` +
          "ADMIN_POOL_MAX and SLUG_LOCK_POOL_MAX must stay distinct for this reading",
      );
    }
    return only;
  };
  return {
    admin: expectOne(ADMIN_POOL_MAX, "admin"),
    slugLock: expectOne(SLUG_LOCK_POOL_MAX, "slug-lock"),
  };
}

describe("buildPlatformDb pool wiring", () => {
  captureLogs();

  beforeEach(() => {
    pools.length = 0;
  });

  test("the ADMIN pool bounds a RESERVED query, at the pooled deadline", () => {
    buildPlatformDb(platformEnv());
    const { admin } = builtPools();
    // The same number on both paths deliberately: a reservation here is an
    // ordinary short statement (a journal read, a session-slot write), not a
    // held lock, so it has no claim to a longer deadline than the pooled read
    // beside it — and one constant is one thing to keep true.
    expect(admin.reservedQueryTimeoutMs).toBe(PLATFORM_DB_QUERY_TIMEOUT_MS);
    expect(admin.queryTimeoutMs).toBe(PLATFORM_DB_QUERY_TIMEOUT_MS);
    expect(admin.connectTimeoutSeconds).toBe(PLATFORM_DB_CONNECT_TIMEOUT_SECONDS);
  });

  test("the ADMIN pool bounds the ACQUIRE too, which neither query deadline covers", () => {
    buildPlatformDb(platformEnv());
    const { admin } = builtPools();
    // A statement's deadline starts once a connection is in hand, so a request
    // that never got one was bounded by nothing on this side: `reserve()` queues
    // indefinitely, and the first deadline to fire belonged to the guest, in
    // another process. What that produced was a timeout with no status where the
    // honest answer is "no connection available" — a 503.
    expect(admin.reserveTimeoutMs).toBe(PLATFORM_DB_RESERVE_TIMEOUT_MS);
    // Under the tightest caller's own budget (`SESSION_STATE_TIMEOUT_MS`, 10s),
    // because a bound that fires after the caller has given up answers nobody.
    expect(admin.reserveTimeoutMs).toBeLessThan(10_000);
  });

  test("the SLUG-LOCK pool leaves a reservation UNBOUNDED", () => {
    buildPlatformDb(platformEnv());
    const { slugLock } = builtPools();
    // Its reservation holds `pg_advisory_lock` for a whole deploy — blob
    // uploads, config extraction, a sandbox spawn — so either query bound
    // would abort deploys. The wait that does need one, the ACQUIRE, carries
    // `lock_timeout` on the connection (`platform-lock.ts`).
    expect(slugLock.reservedQueryTimeoutMs).toBeUndefined();
    expect(slugLock.queryTimeoutMs).toBeUndefined();
    // And the ACQUIRE is unbounded here for a sharper reason than the queries
    // are: a fifth concurrent distinct-slug mutation waits minutes for one of
    // this pool's four connections LEGITIMATELY, so the deadline the admin pool
    // takes would fail deploys under ordinary load.
    expect(slugLock.reserveTimeoutMs).toBeUndefined();
    // The CONNECT bound it does take: nothing about establishing a connection
    // is unbounded by nature.
    expect(slugLock.connectTimeoutSeconds).toBe(PLATFORM_DB_CONNECT_TIMEOUT_SECONDS);
  });

  test("builds exactly two pools, and BOTH readings of them agree", () => {
    // Two things, and neither is what this test used to assert. `builtPools`
    // now identifies by `max`, so re-asserting `max` here would be circular —
    // it would restate the selector.
    //
    // What is worth pinning is the PREMISE that selector rests on (the two
    // constants are distinct, or the identification is ambiguous and every test
    // in this describe silently reads one pool twice) and the fact that the
    // reading it REPLACED still gives the same answer: the admin pool is built
    // first. That is no longer load-bearing, which is exactly why it is worth a
    // cheap assertion — a `buildPlatformDb` that reorders its two pools is a
    // thing to find out about here rather than in whichever test next assumes
    // it.
    expect(ADMIN_POOL_MAX).not.toBe(SLUG_LOCK_POOL_MAX);
    buildPlatformDb(platformEnv());
    const { admin, slugLock } = builtPools();
    expect(pools[0]).toBe(admin);
    expect(pools[1]).toBe(slugLock);
  });

  test("the pooler routes the ADMIN pool only; the slug lock stays DIRECT", () => {
    buildPlatformDb(platformEnv({ PLATFORM_POOLER_URL: POOLER_URL }));
    const { admin, slugLock } = builtPools();
    // Transaction-mode multiplexing is what keeps `ADMIN_POOL_MAX x
    // MAX_CONTAINERS` out of the instance's `max_connections`; the slug lock
    // may not use it at all, a session-scoped advisory lock taken through a
    // transaction pooler excluding nothing.
    expect(admin.url).toBe(POOLER_URL);
    expect(slugLock.url).toBe(DIRECT_URL);
  });
});

/**
 * The composed `adminDb`, read one member at a time.
 *
 * THROWS rather than asserting, so it is legal outside a test body. An absent
 * handle on this tier is a wiring failure and not a case to branch on.
 */
function adminOf(env: NodeJS.ProcessEnv): AdminDb {
  const { adminDb } = buildPlatformDb(env);
  if (!adminDb) throw new Error("the platform tier must expose adminDb");
  return adminDb;
}

/** Every URL a call of `kind` reached, in order. */
function reached(kind: "listen" | "reserve"): string[] {
  return calls.filter((call) => call.kind === kind).map((call) => call.url);
}

describe("the queue LISTEN's own connection", () => {
  captureLogs();

  beforeEach(() => {
    pools.length = 0;
    calls.length = 0;
  });

  test("`listen` reaches the SESSION-mode URL while `reserve` reaches the POOLER", async () => {
    // The whole bug, as one assertion. A `LISTEN` subscription is session state
    // and Supavisor in transaction mode returns the backend after every
    // statement (supabase/supavisor#85), so a subscription opened on the admin
    // pool ESTABLISHED and then received nothing — and every layer stayed quiet
    // about it: `NOTIFY` is an ordinary statement and works pooled, and the
    // scheduler's `.catch` only fires when a subscription fails to establish.
    // With the 1s interval as a designed fallback the only symptom was every
    // step-to-step hop paying it again.
    const adminDb = adminOf(platformEnv({ PLATFORM_POOLER_URL: POOLER_URL }));
    await adminDb.listen("aai_test_channel", () => undefined);
    (await adminDb.reserve()).release();

    expect(reached("listen")).toEqual([DIRECT_URL]);
    // The other half, and it has to be asserted here too: moving the `LISTEN`
    // off the admin pool must not take the RESERVATION with it. Transaction
    // pooling is what keeps `ADMIN_POOL_MAX x MAX_CONTAINERS` out of the
    // instance's `max_connections`, and every guest platform route reserves
    // from that pool.
    expect(reached("reserve")).toEqual([POOLER_URL]);
  });

  test("with no pooler configured both members reach the same direct URL", async () => {
    // Which is why the bug was invisible in dev and in every test that came
    // before this one: unset, `poolerUrl` falls back to `url`, so the two
    // handles differ in nothing an assertion could read. The routing only
    // splits where production sets it — which is why the test above sets it.
    const adminDb = adminOf(platformEnv());
    await adminDb.listen("aai_test_channel", () => undefined);
    (await adminDb.reserve()).release();

    expect(reached("listen")).toEqual([DIRECT_URL]);
    expect(reached("reserve")).toEqual([DIRECT_URL]);
  });

  test("the handle is LAZY, memoized, and sized at the budget term", async () => {
    const adminDb = adminOf(platformEnv());
    // Lazy is what keeps "exactly two pools at construction" true, which is the
    // premise `builtPools` above reads by.
    const before = pools.length;
    expect(before).toBe(2);

    await adminDb.listen("first", () => undefined);
    await adminDb.listen("second", () => undefined);
    // Identified by having APPEARED when we listened, rather than by any option
    // this test then asserts.
    const listener = pools[before];
    expect(pools).toHaveLength(before + 1);

    expect(listener?.url).toBe(DIRECT_URL);
    // One connection is the whole handle, and the fleet budget's
    // `QUEUE_NOTIFY_LISTEN` term is that same one.
    expect(listener?.max).toBe(QUEUE_NOTIFY_LISTEN);
    // Deliberately UNSET: postgres.js opens the listening connection outside
    // this pool with its own `max: 1, idle_timeout: null`, so the driver already
    // pins the lifetime of the only connection that exists and a value here
    // would be dead config.
    expect(listener?.idleTimeoutSeconds).toBeUndefined();
    // Inherited by that listening connection, which copies these options.
    expect(listener?.connectTimeoutSeconds).toBe(PLATFORM_DB_CONNECT_TIMEOUT_SECONDS);
    // Neither query bound: this handle issues no query of ours at all.
    expect(listener?.queryTimeoutMs).toBeUndefined();
    expect(listener?.reservedQueryTimeoutMs).toBeUndefined();
  });
});

describe("buildServiceConfig auth wiring", () => {
  const logs = captureLogs();

  beforeEach(() => {
    pools.length = 0;
  });

  test("the API-key verifier is DERIVED from AAI_LOCAL_DEV, not hardcoded", async () => {
    // An absent verifier is the `Bearer <anything>` hole: unverified raw keys
    // may claim a slug and spawn a sandbox. Both directions in one test, because
    // the claim is the DERIVATION — a literal `true` at the call site would pass
    // any assertion about the option object's shape while disabling verification
    // in production.
    const strict = await buildServiceConfig(serviceEnv());
    expect(strict.keyVerifier).toBeDefined();
    const declaredLocal = await buildServiceConfig(serviceEnv({ AAI_LOCAL_DEV: "1" }));
    expect(declaredLocal.keyVerifier).toBeUndefined();
  });

  test("a PUBLISHABLE key in SUPABASE_SERVICE_ROLE_KEY is refused", async () => {
    // Reaching the guard is the assertion — that `assertServiceRoleKey` refuses
    // this key is `_boot.ts`'s own spec. On an anon key, deploy blob writes die
    // on `storage.objects` RLS and every Realtime subscribe retries forever, so
    // the service boots healthy and silently stops invalidating sandboxes.
    await expect(
      buildServiceConfig(serviceEnv({ SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE_KEY })),
    ).rejects.toThrow(/PUBLISHABLE/);
  });

  test("...on the memory tier under AAI_LOCAL_DEV=1 too", async () => {
    // The guard used to be skipped in local dev, which exempted the one tier
    // where a developer is most likely to have pasted the publishable key. This
    // is the case that reddens if that skip comes back.
    await expect(
      buildServiceConfig(
        memoryEnv({ SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE_KEY, AAI_LOCAL_DEV: "1" }),
      ),
    ).rejects.toThrow(/PUBLISHABLE/);
  });

  test("dev tokens are refused against real stores", async () => {
    // The fourth guard of this shape, and the one this spec tripped over while
    // being written: a platform database with no browser-auth credential must
    // not fall back to the no-auth dev-token implementation. Free to assert now
    // the fixture exists, and the same failure direction as the three above.
    const { SUPABASE_PUBLISHABLE_KEY: _dropped, ...noBrowserAuth } = serviceEnv();
    await expect(buildServiceConfig(noBrowserAuth)).rejects.toThrow(/dev tokens/);
    // The memory tier is where that implementation is legitimate.
    await expect(buildServiceConfig(memoryEnv())).resolves.toBeDefined();
  });

  test("the guest-token warning follows hasPlatformDb: a platform db WARNS", async () => {
    await buildServiceConfig(serviceEnv());
    expect(logs.warns().filter((w) => w.includes(GUEST_TOKEN_SECRET_ENV))).toHaveLength(1);
  });

  test("...and the memory tier, a single process, does NOT", async () => {
    // The other half of the same derived argument: a deployment with no platform
    // database has no peer for a per-process token to be unreachable from, so a
    // hardcoded `true` would warn here about a degradation that cannot exist.
    await buildServiceConfig(memoryEnv());
    expect(logs.warns().filter((w) => w.includes(GUEST_TOKEN_SECRET_ENV))).toHaveLength(0);
  });
});
