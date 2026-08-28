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
 */

import { HTTPException } from "hono/http-exception";
import { describe, expect, test, vi } from "vitest";
import { notConfigured, withReserved } from "./_platform-route.ts";
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

const CALL = { log, failure: "storage call failed", detail: { slug: "my-agent" } };

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

test("notConfigured is a 501, because a retry will not make one", () => {
  // 501 and not 503 is the distinction the guest's whole retry policy rests on.
  const err = notConfigured("platform queue");
  expect(err.status).toBe(501);
  expect(err.message).toBe("platform queue not configured");
});
