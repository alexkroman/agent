// Copyright 2026 the AAI authors. MIT license.
/**
 * The frame the five guest-called platform routes are written inside.
 *
 * What is worth pinning is the part that had already drifted between the four
 * copies, plus the one property no route's own suite can demonstrate about the
 * others:
 *
 * - **An `HTTPException` raised inside the work is an ANSWER, not a failure.**
 *   Three of the four rethrew it; the enqueue route flattened it into a 503, which
 *   tells the guest to retry a request that can never succeed. The storage route
 *   has a spec for the case that produces one ("a method their world does not
 *   expose answers 501, not 500") and the enqueue route had the same code path
 *   with no guard.
 * - **The connection is released on every path**, including the two that throw.
 *   A reservation leaked per failing call exhausts the admin pool, which is the
 *   failure that takes every tenant down rather than one.
 * - **A status the route claims for itself is not logged as a failure.** The
 *   upload records route answers 409 to a refused claim, which is that route
 *   working.
 * - **The ACQUIRE is timed, and every outcome of it says so.** A route holds one
 *   of `ADMIN_POOL_MAX` connections for its whole duration, and until this the
 *   only number anybody had was the total — so "the journal RPC costs ~840 ms"
 *   could not be attributed to our own pool or to the round trip. The cases below
 *   are the answers a request can print, and the failed-acquire one is a line
 *   that did not exist at all: the reservation is taken before the `try`, so
 *   `POOL_EXHAUSTED` reached the router with nothing naming the slug.
 * - **A SUCCEEDING call says how long its statement took**, which is the half
 *   that was missing: `workMs` was computed in the `catch` and nowhere else, so
 *   the `elapsed - (waited + work)` breakdown two guides advertise was absent
 *   from every request that worked (measured: 11 `waitedMs` lines and zero
 *   `workMs` on a local platform run). A spec over the failure path cannot see
 *   that — it is the population an operator is not asking about.
 */

import { HTTPException } from "hono/http-exception";
import { describe, expect, test, vi } from "vitest";
import { notConfigured, RESERVE_WAIT_WARN_MS, withReserved } from "./_platform-route.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import { captureLogs } from "./test-utils.ts";

const log = createLogger("test.route");

// At module scope, because `captureLogs` installs `beforeEach`/`afterEach` — called
// inside a test body it registers its hooks too late to have recorded anything.
const logs = captureLogs();

/** An admin pool that counts what it handed out and what came back. */
function countingDb(): { db: AdminDb; released: () => number; reserved: () => number } {
  let handedOut = 0;
  let givenBack = 0;
  return {
    released: () => givenBack,
    reserved: () => handedOut,
    db: {
      // Never used here — this frame reserves, it does not subscribe.
      listen: () => Promise.resolve(() => undefined),
      reserve: () => {
        handedOut += 1;
        return Promise.resolve({
          query: () => Promise.resolve([]),
          release: () => {
            givenBack += 1;
          },
        });
      },
    } as AdminDb,
  };
}

const CALL = {
  log,
  failure: "storage call failed",
  detail: { slug: "my-agent" },
  // The key is REQUIRED with an optional value, so every route has to look for a
  // trace even when there is not one. Absent here except where a case is about it.
  trace: undefined,
};

test("hands the work a query function bound to the reserved connection", async () => {
  const { db } = countingDb();
  const run = vi.fn(async (sql: (q: string, p?: unknown[]) => Promise<unknown>) => {
    await sql("select 1", [7]);
    return "done";
  });
  await expect(withReserved(db, CALL, run)).resolves.toBe("done");
  expect(run).toHaveBeenCalledOnce();
});

describe("the connection comes back", () => {
  test("after work that succeeded", async () => {
    const { db, released, reserved } = countingDb();
    await withReserved(db, CALL, async () => "ok");
    expect([reserved(), released()]).toEqual([1, 1]);
  });

  test("after work that threw an answer", async () => {
    const { db, released } = countingDb();
    await expect(
      withReserved(db, CALL, () => {
        throw new HTTPException(400, { message: "queueName is required" });
      }),
    ).rejects.toThrow();
    expect(released()).toBe(1);
  });

  test("after work that threw anything else", async () => {
    const { db, released } = countingDb();
    await expect(
      withReserved(db, CALL, () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow();
    expect(released()).toBe(1);
  });
});

describe("what the work threw", () => {
  test("an HTTPException survives as itself, rather than becoming a 503", async () => {
    // The drift this frame exists to remove: a 501 for a method the world does not
    // expose, re-wrapped as a 503, tells the guest to back off and retry forever.
    const { db } = countingDb();
    const answer = withReserved(db, CALL, () => {
      throw new HTTPException(501, { message: "storage method unavailable" });
    });
    await expect(answer).rejects.toMatchObject({ status: 501 });
    // Not a failure, so not a warn line either.
    expect(logs.warns()).toEqual([]);
  });

  test("a status the route claims for itself wins over the 503, unlogged", async () => {
    const { db } = countingDb();
    class IdTaken extends Error {}
    const answer = withReserved(
      db,
      {
        ...CALL,
        statusFor: (err) =>
          err instanceof IdTaken
            ? new HTTPException(409, { message: "upload id already taken" })
            : undefined,
      },
      () => {
        throw new IdTaken("taken");
      },
    );
    await expect(answer).rejects.toMatchObject({ status: 409 });
    expect(logs.warns()).toEqual([]);
  });

  test("anything else becomes a 503, warned with the slug and the reason", async () => {
    const { db } = countingDb();
    const answer = withReserved(
      db,
      { ...CALL, detail: { slug: "my-agent", method: "runs.get" } },
      () => {
        throw new Error("connection reset");
      },
    );
    await expect(answer).rejects.toMatchObject({ status: 503 });
    const warned = logs.warns().join(" ");
    expect(warned).toContain("storage call failed");
    expect(logs.all().at(-1)?.ctx).toMatchObject({
      slug: "my-agent",
      method: "runs.get",
      error: "connection reset",
    });
  });

  test("the warn line and the tenant's 503 can say different things", async () => {
    // The enqueue route's shape: a tenant reads "could not queue the message" and
    // an operator greps for "enqueue failed".
    const { db } = countingDb();
    const answer = withReserved(
      db,
      { ...CALL, failure: "could not queue the message", logMessage: "enqueue failed" },
      () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    await expect(answer).rejects.toMatchObject({
      status: 503,
      message: "could not queue the message",
    });
    expect(logs.warns().join(" ")).toContain("enqueue failed");
  });
});

describe("the acquire is timed", () => {
  /**
   * A pool whose `reserve()` costs `waitMs` on a clock the test owns.
   *
   * `performance.now` is stubbed to READ a mutable counter rather than to answer
   * a scripted sequence, so the fake does not have to know how many times
   * `withReserved` reads the clock — which is the coupling that makes a timing
   * test fail on an unrelated edit. `restoreMocks` puts the real one back.
   */
  function slowDb(waitMs: number, fail?: Error): AdminDb {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    return {
      listen: () => Promise.resolve(() => undefined),
      reserve: async () => {
        clock += waitMs;
        if (fail) throw fail;
        return { query: () => Promise.resolve([]), release: () => undefined };
      },
    } as AdminDb;
  }

  const debugs = () => logs.all().filter((l) => l.level === "debug");

  test("an ordinary wait is a DEBUG line, so it costs nothing unless asked for", async () => {
    await withReserved(slowDb(1), CALL, async () => "ok");
    // Two lines, in order: the acquire's outcome the moment it returns, then the
    // statement's when it comes back.
    expect(debugs().map((l) => l.msg)).toEqual([
      "test.route Platform admin reservation",
      "test.route Platform admin statement",
    ]);
    expect(debugs()[0]?.ctx).toMatchObject({ slug: "my-agent", waitedMs: 1 });
    // Not news, so not a warn: an operator greps warns for a pool with nothing
    // to give, and one line per request would drown it.
    expect(logs.warns()).toEqual([]);
  });

  test("a wait past the threshold WARNS, naming the pool rather than the route", async () => {
    await withReserved(slowDb(RESERVE_WAIT_WARN_MS), CALL, async () => "ok");
    expect(logs.warns()).toEqual(["test.route Platform admin reservation was slow"]);
    expect(logs.all().find((l) => l.level === "warn")?.ctx).toMatchObject({
      slug: "my-agent",
      waitedMs: RESERVE_WAIT_WARN_MS,
    });
    // The WAIT is reported once, at the level the number deserves — never both.
    // The statement line beside it is a different fact and stays at DEBUG: the
    // acquire is what an operator was warned about, and a duration with no
    // threshold is not a second alarm.
    expect(debugs().map((l) => l.msg)).toEqual(["test.route Platform admin statement"]);
  });

  test("a FAILED acquire warns with the wait it spent, and rethrows unchanged", async () => {
    const exhausted = Object.assign(new Error("no connection available"), {
      code: "POOL_EXHAUSTED",
    });
    // Rethrown as itself: `isPlatformDbUnreachable` reads that code to decide the
    // 503, so wrapping it here would take the classification away from the layer
    // that owns it.
    await expect(withReserved(slowDb(5000, exhausted), CALL, async () => "ok")).rejects.toBe(
      exhausted,
    );
    expect(logs.warns()).toEqual(["test.route Platform admin reservation failed"]);
    expect(logs.all().at(-1)?.ctx).toMatchObject({
      slug: "my-agent",
      waitedMs: 5000,
      error: "no connection available",
    });
  });

  test("a SUCCEEDING call says how long its statement took, not just its wait", async () => {
    // The defect: `workMs` was computed in the `catch` and nowhere else, so the
    // breakdown `_trace-context.ts` documents was absent from every healthy
    // request — 11 `waitedMs` lines and zero `workMs` on a measured local run.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const db = {
      listen: () => Promise.resolve(() => undefined),
      reserve: async () => {
        clock += 2;
        return { query: () => Promise.resolve([]), release: () => undefined };
      },
    } as AdminDb;
    await expect(
      withReserved(db, CALL, async () => {
        clock += 41;
        return "ok";
      }),
    ).resolves.toBe("ok");
    const statement = logs.all().find((l) => l.msg.endsWith("Platform admin statement"));
    // `waitedMs` is repeated so the second line answers the question on its own,
    // rather than only in company with the first.
    expect(statement?.ctx).toMatchObject({ slug: "my-agent", waitedMs: 2, workMs: 41 });
  });

  test("the wait is already reported while the work is still running", async () => {
    // Which is why this is two lines rather than one moved below `run`: the wait
    // line is the pool alarm, so a statement that hangs forever must not be able
    // to swallow it. Observed from inside the work, the acquire's line is written
    // and the statement's is not.
    const { db } = countingDb();
    let seenFromInside: string[] = [];
    await withReserved(db, CALL, async () => {
      seenFromInside = debugs().map((l) => l.msg);
      return "ok";
    });
    expect(seenFromInside).toEqual(["test.route Platform admin reservation"]);
  });

  test("a 503 says how much of itself was queueing and how much was work", async () => {
    // The distinction the old line could not make: 20 ms of work behind 4,900 ms
    // of queueing is a pool incident; thirty seconds inside a statement is not.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const db = {
      listen: () => Promise.resolve(() => undefined),
      reserve: async () => {
        clock += 4900;
        return { query: () => Promise.resolve([]), release: () => undefined };
      },
    } as AdminDb;
    await expect(
      withReserved(db, CALL, () => {
        clock += 20;
        throw new Error("connection reset");
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(logs.all().at(-1)?.ctx).toMatchObject({ waitedMs: 4900, workMs: 20 });
  });
});

/**
 * The other end of the guest's `traceparent`, which is what makes the two sides
 * of the ~840 ms hop JOINABLE.
 *
 * A busy replica writes hundreds of these lines a second, so a timestamp cannot
 * put a caller's elapsed beside this side's `waitedMs`/`workMs` and an id can.
 * Every line `withReserved` writes therefore carries it — and NONE of them
 * carries an empty one, which is the half worth pinning: a `traceId: undefined`
 * in a log context reads as a caller that sent a broken header rather than one
 * that sent none.
 */
describe("the caller's trace id", () => {
  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const traced = { ...CALL, trace: TRACE };

  test("is on the reservation line, beside the wait it explains", async () => {
    const { db } = countingDb();
    await withReserved(db, traced, async () => "ok");
    expect(logs.all().at(-1)?.ctx).toMatchObject({ slug: "my-agent", traceId: TRACE });
  });

  test("is on the statement line, which is what makes the hop computable", async () => {
    // `elapsed - (waited + work)` needs both server lines under one id: the wait
    // line alone leaves the statement inside the unaccounted remainder.
    const { db } = countingDb();
    await withReserved(db, traced, async () => "ok");
    const statement = logs.all().find((l) => l.msg.endsWith("Platform admin statement"));
    expect(statement?.ctx).toMatchObject({ traceId: TRACE, slug: "my-agent" });
    expect(statement?.ctx).toHaveProperty("workMs");
  });

  test("is on the 503's warn, so a failed call is correlatable too", async () => {
    const { db } = countingDb();
    await expect(
      withReserved(db, traced, () => {
        throw new Error("connection reset");
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(logs.all().at(-1)?.ctx).toMatchObject({ traceId: TRACE, error: "connection reset" });
  });

  test("is on a FAILED acquire, which is the line that had no trace at all", async () => {
    const failing = {
      listen: () => Promise.resolve(() => undefined),
      reserve: () => Promise.reject(new Error("no connection available")),
    } as AdminDb;
    await expect(withReserved(failing, traced, async () => "ok")).rejects.toThrow();
    expect(logs.all().at(-1)?.ctx).toMatchObject({ traceId: TRACE });
  });

  test("is OMITTED rather than empty when the caller sent none", async () => {
    const { db } = countingDb();
    await withReserved(db, CALL, async () => "ok");
    expect(logs.all().at(-1)?.ctx).not.toHaveProperty("traceId");
  });
});

test("notConfigured is a 501, because a retry will not make one", () => {
  // 501 and not 503 is the distinction the guest's whole retry policy rests on.
  const err = notConfigured("platform queue");
  expect(err.status).toBe(501);
  expect(err.message).toBe("platform queue not configured");
});
