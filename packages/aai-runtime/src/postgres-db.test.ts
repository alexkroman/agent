// Copyright 2026 the AAI authors. MIT license.

import { MAX_DB_RESULT_ROWS } from "@alexkroman1/aai/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPostgresDb } from "./postgres-db.ts";

// Shape-only tests: the `postgres` module is mocked so no connection is ever
// opened — what matters is the options the client is built with and how the
// Db contract maps onto `unsafe`/`end`.
const unsafeMock = vi.fn();
const endMock = vi.fn(() => Promise.resolve());
const releaseMock = vi.fn();
const reserveMock = vi.fn(() => Promise.resolve({ unsafe: unsafeMock, release: releaseMock }));
const postgresMock = vi.fn((..._args: unknown[]) => ({
  unsafe: unsafeMock,
  reserve: reserveMock,
  end: endMock,
}));

/**
 * The options `createPostgresDb` built its client with.
 *
 * A typed reader rather than `mock.calls[0]?.[1]` re-narrowed per assertion: the
 * mock takes `unknown[]`, so every read of a named option was an error the
 * alternative to which is a cast — and `onnotice` is a FUNCTION three tests
 * invoke, which is exactly where an unchecked read stops being cheap.
 */
function clientOptions(): {
  max?: number;
  prepare?: boolean;
  idle_timeout?: number;
  connect_timeout?: number;
  onnotice?: (n: unknown) => void;
} {
  const [, options] = postgresMock.mock.calls[0] ?? [];
  return (options ?? {}) as ReturnType<typeof clientOptions>;
}

vi.mock("postgres", () => ({ default: (...args: unknown[]) => postgresMock(...args) }));

/**
 * Construct a handle AND force the deferred driver load.
 *
 * `createPostgresDb` imports `postgres` and builds the client on first USE, not
 * at construction (see its doc), so a test asserting on `clientOptions()` has
 * to make one call first. Without this the assertions do not fail — they pass
 * VACUOUSLY: `clientOptions()` reads `mock.calls[0]` and returns `{}` when the
 * client was never built, so `connect_timeout` is `undefined` and `onnotice` is
 * an optional call that never happens. Four of these tests went green that way
 * before the helper existed, which is why every `clientOptions()` reader goes
 * through it.
 */
async function opened(options: Parameters<typeof createPostgresDb>[0]) {
  unsafeMock.mockResolvedValueOnce([]);
  const db = createPostgresDb(options);
  await db.query("select 1");
  return db;
}

/** A query the driver never answers — the shape a silent partition produces. */
const pending = (): Promise<never> => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPostgresDb", () => {
  test("builds the client with the url, a bounded pool, and prepare disabled", async () => {
    await opened({ url: "postgres://db.example/app" });
    // `onnotice` is asserted as PRESENT rather than by identity: postgres.js has
    // no silent default, so leaving it unset is what dumped a whole `42P07`
    // notice object into every guest's stdout on every boot.
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith("postgres://db.example/app", {
      max: 4,
      prepare: false,
      // The one option postgres.js has no useful default for: unset, it keeps
      // every idle connection for the life of the process, and on the platform
      // those are charged against the app role's `connection limit` whether or
      // not anything is using them.
      idle_timeout: expect.any(Number),
      onnotice: expect.any(Function),
    });
    expect(clientOptions().idle_timeout).toBeGreaterThan(0);
  });

  test("a NOTICE prints nothing by default, and does not throw", async () => {
    // The fix, stated as the thing an operator sees: postgres.js's own default
    // dumps the whole notice OBJECT, and ours routes it to `consoleLogger.debug`,
    // which is a no-op unless `AAI_DEBUG=1`. So the channel is quiet by default
    // and recoverable on demand — rather than swallowed, which is how the next
    // notice that MATTERS (a truncated identifier, a constraint silently
    // declined) would go unseen.
    const spies = (["debug", "info", "warn", "error", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    createPostgresDb({ url: "postgres://db.example/app" });
    const { onnotice } = clientOptions();
    expect(() =>
      onnotice?.({
        severity: "NOTICE",
        code: "42P07",
        message: 'relation "aai_session_events" already exists, skipping',
        file: "parse_utilcmd.c",
      }),
    ).not.toThrow();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("a malformed notice cannot take a session down", async () => {
    // It is a callback the DRIVER invokes, so a throw here escapes into the
    // driver's own event handling rather than to any caller.
    await opened({ url: "postgres://db.example/app" });
    const { onnotice } = clientOptions();
    for (const bad of [undefined, null, "a string", 42]) {
      expect(() => onnotice?.(bad)).not.toThrow();
    }
  });

  test("an explicit onNotice wins, so an embedder can route notices itself", async () => {
    const onNotice = vi.fn();
    await opened({ url: "postgres://db.example/app", onNotice });
    const { onnotice: wired } = clientOptions();
    wired?.({ code: "42P07" });
    expect(onNotice).toHaveBeenCalledOnce();
  });

  test("honors an explicit max", async () => {
    await opened({ url: "postgres://db.example/app", max: 1 });
    expect(clientOptions().max).toBe(1);
  });

  test("honors an explicit idle timeout, zero included", async () => {
    // Zero is the meaningful value, not a fallback to the default: postgres.js
    // treats a falsy `idle_timeout` as "never close", which is what a pool whose
    // one connection is reserved for the process's life wants (the workflow lock
    // sweep's presence lock). `?? DEFAULT` would have silently overridden it.
    await opened({ url: "postgres://db.example/app", idleTimeoutSeconds: 0 });
    expect(clientOptions().idle_timeout).toBe(0);
  });

  test("honors a non-zero idle timeout", async () => {
    await opened({ url: "postgres://db.example/app", idleTimeoutSeconds: 5 });
    expect(clientOptions().idle_timeout).toBe(5);
  });

  test("query runs the statement with its params and resolves the rows", async () => {
    unsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    const rows = await db.query<{ id: number }>("select id from t where id > $1", [0]);
    expect(unsafeMock).toHaveBeenCalledExactlyOnceWith("select id from t where id > $1", [0]);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("query defaults params to an empty array", async () => {
    unsafeMock.mockResolvedValueOnce([]);
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await db.query("select 1");
    expect(unsafeMock).toHaveBeenCalledExactlyOnceWith("select 1", []);
  });

  test("query throws (never truncates) past MAX_DB_RESULT_ROWS", async () => {
    unsafeMock.mockResolvedValueOnce(
      Array.from({ length: MAX_DB_RESULT_ROWS + 1 }, (_, i) => ({ i })),
    );
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.query("select * from big")).rejects.toThrow(
      `query returned more than ${MAX_DB_RESULT_ROWS} rows; add a LIMIT`,
    );
  });

  test("query resolves exactly MAX_DB_RESULT_ROWS rows without throwing", async () => {
    unsafeMock.mockResolvedValueOnce(Array.from({ length: MAX_DB_RESULT_ROWS }, (_, i) => ({ i })));
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.query("select * from big")).resolves.toHaveLength(MAX_DB_RESULT_ROWS);
  });

  test("query rejects when the driver rejects", async () => {
    unsafeMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.query("select * from missing")).rejects.toThrow("relation does not exist");
  });

  test("close ends the pool", async () => {
    const db = await opened({ url: "postgres://db.example/app" });
    await db.close();
    expect(endMock).toHaveBeenCalledOnce();
  });

  test("close on a handle that was never used loads no driver and ends nothing", async () => {
    // The deferral's other half: a caller tearing down a pool it never queried
    // must not pay for the import just to close it.
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.close()).resolves.toBeUndefined();
    expect(postgresMock).not.toHaveBeenCalled();
    expect(endMock).not.toHaveBeenCalled();
  });

  test("the driver is built once no matter how many calls follow", async () => {
    const db = await opened({ url: "postgres://db.example/app" });
    unsafeMock.mockResolvedValueOnce([]);
    unsafeMock.mockResolvedValueOnce([]);
    await Promise.all([db.query("select 1"), db.query("select 2")]);
    expect(postgresMock).toHaveBeenCalledOnce();
  });

  test("passes connectTimeoutSeconds through as connect_timeout", async () => {
    await opened({ url: "postgres://db.example/app", connectTimeoutSeconds: 10 });
    expect(clientOptions().connect_timeout).toBe(10);
  });

  test("omits connect_timeout when unset (keeps the driver default)", async () => {
    await opened({ url: "postgres://db.example/app" });
    expect(clientOptions().connect_timeout).toBeUndefined();
  });
});

describe("createPostgresDb query timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a POOLED query that stalls past queryTimeoutMs rejects with a QUERY_TIMEOUT code", async () => {
    // The stall a network partition produces: an established connection that
    // never answers. Only a client-side deadline can end it.
    unsafeMock.mockReturnValueOnce(pending());
    const db = createPostgresDb({ url: "postgres://db.example/app", queryTimeoutMs: 5000 });
    const assertion = expect(db.query("select 1")).rejects.toMatchObject({
      code: "QUERY_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  test("a fast POOLED query resolves normally under queryTimeoutMs", async () => {
    unsafeMock.mockResolvedValueOnce([{ ok: 1 }]);
    const db = createPostgresDb({ url: "postgres://db.example/app", queryTimeoutMs: 5000 });
    await expect(db.query("select 1")).resolves.toEqual([{ ok: 1 }]);
  });

  test("a RESERVED query is NOT bounded by queryTimeoutMs (advisory-lock waits are exempt)", async () => {
    unsafeMock.mockReturnValueOnce(pending());
    const db = createPostgresDb({ url: "postgres://db.example/app", queryTimeoutMs: 5000 });
    const reserved = await db.reserve();
    let settled = false;
    void reserved.query("select pg_advisory_lock(1, 2)").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Advance well past the pooled deadline — a reserved query must still hang.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });

  test("a RESERVED query IS bounded once reservedQueryTimeoutMs is set", async () => {
    // The hole this closes: every guest journal / session-state / uploads /
    // enqueue call runs on a RESERVED connection (`_platform-route.ts`'s
    // `withReserved`) and takes no advisory lock, so the exemption above left
    // them with no deadline at all — four hung reads exhaust `ADMIN_POOL_MAX`
    // and every other platform read on the replica queues behind them.
    unsafeMock.mockReturnValueOnce(pending());
    const db = createPostgresDb({
      url: "postgres://db.example/app",
      queryTimeoutMs: 5000,
      reservedQueryTimeoutMs: 5000,
    });
    const reserved = await db.reserve();
    // The same `QUERY_TIMEOUT` code the pooled path raises, which is what puts
    // it in `aai-server`'s `UNREACHABLE_CODES` and answers 503.
    const assertion = expect(reserved.query("select 1")).rejects.toMatchObject({
      code: "QUERY_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  test("a fast RESERVED query resolves normally under reservedQueryTimeoutMs", async () => {
    unsafeMock.mockResolvedValueOnce([{ ok: 1 }]);
    const db = createPostgresDb({
      url: "postgres://db.example/app",
      reservedQueryTimeoutMs: 5000,
    });
    const reserved = await db.reserve();
    await expect(reserved.query("select 1")).resolves.toEqual([{ ok: 1 }]);
  });

  test("the SLUG-LOCK pool's own options leave a reservation unbounded", async () => {
    // Exactly what `service-config.ts` builds that pool with, and the reason the
    // bound above is per-pool rather than a blanket: this reservation holds
    // `pg_advisory_lock` for a whole deploy — blob uploads and a sandbox spawn,
    // i.e. seconds to minutes — and a client-side deadline on it would abort
    // deploys. Its acquire wait is bounded by `lock_timeout` instead
    // (`platform-lock.ts`), which is the deadline that belongs there.
    unsafeMock.mockReturnValueOnce(pending());
    const db = createPostgresDb({ url: "postgres://db.example/app", connectTimeoutSeconds: 10 });
    const reserved = await db.reserve();
    let settled = false;
    void reserved.query("select pg_advisory_lock(1, 2)").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });

  test("a query is unbounded when queryTimeoutMs is unset", async () => {
    unsafeMock.mockReturnValueOnce(pending());
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    let settled = false;
    void db.query("select 1").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });
});

/**
 * The wait to GET a connection, which the two query deadlines do not cover.
 *
 * `sql.reserve()` queues indefinitely at exhaustion, so the first deadline to
 * fire belonged to whoever was waiting on the request — the guest's own 10-15s
 * request timeouts, in another process — and the caller then reported a timeout
 * against a layer that was never reached.
 */
describe("createPostgresDb reserve timeout", () => {
  /** A reservation the pool never grants: every connection is taken. */
  const queued = () =>
    Promise.withResolvers<{ unsafe: typeof unsafeMock; release: typeof releaseMock }>();

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a reserve that queues past reserveTimeoutMs rejects with a POOL_EXHAUSTED code", async () => {
    reserveMock.mockReturnValueOnce(queued().promise);
    const db = createPostgresDb({ url: "postgres://db.example/app", reserveTimeoutMs: 5000 });
    // The code is the whole point: `aai-server`'s `UNREACHABLE_CODES` reads it
    // and answers 503 with a `Retry-After`, where an unbounded wait produced a
    // caller-side timeout with no status at all.
    const assertion = expect(db.reserve()).rejects.toMatchObject({ code: "POOL_EXHAUSTED" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  test("the ABANDONED reservation is released when the pool finally grants it", async () => {
    // Without this the option makes the shortage PERMANENT: `pTimeout` settles
    // the caller and leaves the driver's promise running, so every expired wait
    // would retire one connection from a pool of four.
    const late = queued();
    reserveMock.mockReturnValueOnce(late.promise);
    const db = createPostgresDb({ url: "postgres://db.example/app", reserveTimeoutMs: 5000 });
    const assertion = expect(db.reserve()).rejects.toMatchObject({ code: "POOL_EXHAUSTED" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(releaseMock).not.toHaveBeenCalled();

    late.resolve({ unsafe: unsafeMock, release: releaseMock });
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  test("a reserve with no reserveTimeoutMs waits forever, which the slug lock needs", async () => {
    // Its reservations are held for a whole deploy, so a fifth concurrent
    // distinct-slug mutation waits minutes for one LEGITIMATELY — a deadline
    // here would fail deploys under ordinary load.
    reserveMock.mockReturnValueOnce(queued().promise);
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    let settled = false;
    void db.reserve().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
  });

  test("a reserve the pool can grant is unaffected by the deadline", async () => {
    const db = createPostgresDb({ url: "postgres://db.example/app", reserveTimeoutMs: 5000 });
    const reserved = await db.reserve();
    reserved.release();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
