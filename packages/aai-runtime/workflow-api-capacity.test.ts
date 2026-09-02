// Copyright 2026 the AAI authors. MIT license.
/**
 * A capacity failure is a 503, not a 500 — the distinction a caller acts on.
 *
 * Found by load: eight workflow guests booted at once against a 100-connection
 * Postgres saturated it, and every `POST /workflows/runs` that could not get a
 * connection answered `Internal server error`. That is indistinguishable from a
 * broken agent, so a client cannot back off, an operator cannot triage, and a
 * load balancer cannot shed.
 */

import { afterEach, describe, expect, test } from "vitest";
import { PLATFORM_ROUTES } from "./platform-endpoint.ts";
import { platformPost } from "./platform-rpc.ts";
import {
  isDiskFull,
  isInsufficientResources,
  isPlatformUnavailable,
  isTransportFailure,
  workflowApiErrorStatus,
} from "./workflow-api-error-status.ts";
import { isCallerGone } from "./workflow-api-http.ts";
import { fakeClient, type Harness, serve } from "./workflow-api-test-utils.ts";

describe("isInsufficientResources", () => {
  /** The one that actually happened, and the one that reaches us WRAPPED. */
  test("finds 53300 through a cause chain", () => {
    const driver = Object.assign(new Error('too many connections for role "app_abc"'), {
      code: "53300",
    });
    // graphile-worker → drizzle → the DevKit's world: none re-throws the
    // original, so the code is only ever reachable through `cause`.
    const wrapped = new Error("the Postgres world migration failed", {
      cause: new Error("query failed", { cause: driver }),
    });
    expect(isInsufficientResources(wrapped)).toBe(true);
    expect(isInsufficientResources(driver)).toBe(true);
  });

  /**
   * The CLASS, not a code list. All four of these mean the database ran out of
   * something and a caller's response to each is identical, so enumerating them
   * is how the next one gets missed.
   */
  test.each(["53300", "53200", "53100", "53400"])("treats %s as capacity", (code) => {
    expect(isInsufficientResources(Object.assign(new Error("x"), { code }))).toBe(true);
  });

  test("is not fooled by a non-capacity SQLSTATE or a foreign code", () => {
    // 42P07 is duplicate_table — a real error, and never retryable.
    expect(isInsufficientResources(Object.assign(new Error("x"), { code: "42P07" }))).toBe(false);
    // A five-character guard, so another vocabulary's `53…` cannot pass as one.
    expect(isInsufficientResources(Object.assign(new Error("x"), { code: "53" }))).toBe(false);
    expect(isInsufficientResources(Object.assign(new Error("x"), { code: "530012" }))).toBe(false);
    expect(isInsufficientResources(new Error("no code at all"))).toBe(false);
    expect(isInsufficientResources(undefined)).toBe(false);
  });

  test("terminates on a cyclic cause chain", () => {
    // A walk without the `seen` set hangs the request it was trying to classify.
    const a: { code?: string; cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(isInsufficientResources(a)).toBe(false);
  });
});

/**
 * A full DISK, which is a different answer from a full database.
 *
 * The condition was observed on a dev sandbox transcribing uploaded audio: a
 * guest with no `DATABASE_URL` keeps run state and upload bytes on local disk,
 * that disk filled, and every layer treated it as transient — the DevKit's queue
 * retried, the platform's forward answered `503 … retry shortly`, and the log
 * filled with identical lines. Retrying a write that failed for want of space
 * fails again.
 */
describe("isDiskFull", () => {
  test("finds ENOSPC through the cause chain the DevKit wraps it in", () => {
    // The `code` is almost never on the value that was thrown: the world, the
    // queue and the API each re-wrap it.
    const driver = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
    const wrapped = new Error("step failed", { cause: new Error("write", { cause: driver }) });
    expect(isDiskFull(wrapped)).toBe(true);
    expect(isDiskFull(driver)).toBe(true);
  });

  test("is not fooled by a message that merely says ENOSPC", () => {
    // The `code` is the signal, not the text — an agent's own error is allowed to
    // mention a disk without becoming one.
    expect(isDiskFull(new Error("ENOSPC: no space left on device"))).toBe(false);
  });

  test("does not confuse a full DATABASE with a full disk", () => {
    // The two need different answers, which is the whole reason for two
    // predicates: one clears on its own, the other does not.
    const pgFull = Object.assign(new Error("too many connections"), { code: "53300" });
    expect(isDiskFull(pgFull)).toBe(false);
    expect(isInsufficientResources(pgFull)).toBe(true);
  });

  test("survives a cause CYCLE rather than hanging", () => {
    // Same guard as its sibling. A cycle is reachable when a wrapper sets
    // `cause` to something that already references it, and a hang here is a
    // wedged request rather than an error.
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(isDiskFull(a)).toBe(false);
  });
});

/**
 * The STATUS a full disk maps to, and the absence of `Retry-After` as a signal.
 */
describe("workflowApiErrorStatus on a full disk", () => {
  const enospc = Object.assign(new Error("write"), { code: "ENOSPC" });

  test("answers 507 and tells the operator what to do about it", () => {
    const mapped = workflowApiErrorStatus(enospc);
    expect(mapped).toMatchObject({ status: 507 });
    // Narrowed with an explicit refusal rather than `mapped?.error`: the union is
    // `false | {…}`, and `false` is not nullish, so an optional chain does not
    // exclude it — biome's `useOptionalChain` suggests one here and is wrong.
    if (mapped === false) expect.fail("a full disk must map to a status");
    expect(mapped.error).toContain("DATABASE_URL");
  });

  test("carries NO Retry-After, unlike the database's 503", () => {
    // The distinction is the point: a saturated pool clears itself, a full disk
    // does not, so advising a retry would be advising a loop.
    expect(workflowApiErrorStatus(enospc)).not.toHaveProperty("retryAfter");
    const pgFull = Object.assign(new Error("too many connections"), { code: "53300" });
    expect(workflowApiErrorStatus(pgFull)).toMatchObject({ status: 503, retryAfter: "1" });
  });

  test("a full disk wins over the database check, because it is more specific", () => {
    // Both predicates would fire on an error carrying both codes down its chain;
    // the disk's answer is the one that must not be retried.
    const both = Object.assign(new Error("write", { cause: enospc }), { code: "53300" });
    expect(workflowApiErrorStatus(both)).toMatchObject({ status: 507 });
  });
});

/**
 * A hop OUT of this agent failing is a 503, and it used to be an opaque 500.
 *
 * The production shape: a deployed guest's part claim probes the bucket through
 * the platform, `fetch` rejected with `TypeError: fetch failed`, and the router
 * answered `500 Internal server error` — six times, ~40 s each, the browser
 * re-sending 8 MB windows it had already stored into the same fault.
 */
describe("workflowApiErrorStatus on a transport failure", () => {
  /** What `fetch` really throws: a bare TypeError with the code two hops down. */
  const fetchFailed = new TypeError("fetch failed", {
    cause: new Error("other side closed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }),
  });

  test("finds the code down the cause chain, where fetch leaves it", () => {
    // The top-level value carries no code at all — which is exactly why this
    // reached the router as an unnamed rejection.
    expect(fetchFailed).not.toHaveProperty("code");
    expect(isTransportFailure(fetchFailed)).toBe(true);
  });

  test.each([
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "ERR_HTTP2_STREAM_ERROR",
    "ERR_HTTP2_GOAWAY_SESSION",
  ])("names %s", (code) => {
    expect(isTransportFailure(Object.assign(new Error("x"), { code }))).toBe(true);
  });

  test("ENOTFOUND is NOT one, because a bad hostname does not clear", () => {
    // Advising a retry on a misconfiguration hides a permanent fault behind a
    // client's loop forever. `EAI_AGAIN` above is the temporary twin.
    const err = Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" });
    expect(isTransportFailure(err)).toBe(false);
    expect(workflowApiErrorStatus(err)).toBe(false);
  });

  test("answers 503 with a Retry-After, which the 500 could not carry", () => {
    const mapped = workflowApiErrorStatus(fetchFailed);
    expect(mapped).toMatchObject({ status: 503, retryAfter: "1" });
    if (mapped === false) expect.fail("a transport failure must map to a status");
    // Names the hop rather than the agent: the request was fine.
    expect(mapped.error).toContain("could not reach");
  });

  test("does not shadow the two entries with better advice", () => {
    // Both a full disk and an exhausted pool surface transport-shaped codes on
    // their way out, and each has a specific answer this one cannot give.
    const enospc = Object.assign(new Error("write"), { code: "ENOSPC" });
    const disk = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset", { cause: enospc }), { code: "ECONNRESET" }),
    });
    expect(workflowApiErrorStatus(disk)).toMatchObject({ status: 507 });
    const pool = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("too many connections", {
          cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        }),
        { code: "53300" },
      ),
    });
    expect(workflowApiErrorStatus(pool)).toMatchObject({ status: 503 });
  });

  test("a CALLER hanging up is still the caller, not a transport failure", () => {
    // `isCallerGone` reads the TOP-level value and is checked first; this reads a
    // wrapped cause. An ECONNRESET on the inbound socket must not become a 503
    // written to a socket that has closed.
    const aborted = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    expect(isCallerGone(aborted)).toBe(true);
    expect(isCallerGone(fetchFailed)).toBe(false);
    // The one that matters, and the A/B that found it: `claimUnder` runs the
    // status table BEFORE its own caller-gone branch, so an unguarded entry
    // answered 503 into a closed socket and swallowed the debug line that keeps
    // navigations-away out of the error log.
    expect(workflowApiErrorStatus(aborted)).toBe(false);
  });

  test("survives a cause CYCLE rather than hanging", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(isTransportFailure(a)).toBe(false);
  });

  test("declines anything it cannot name, so a real fault stays a 500", () => {
    expect(isTransportFailure(new Error("something broke"))).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
    expect(workflowApiErrorStatus(new Error("something broke"))).toBe(false);
  });
});

/**
 * A platform reply this guest should COME BACK for.
 *
 * Driven through the real producer rather than a hand-built error, because the
 * defect was the seam between them: `platformPost` threw a code-less `Error`
 * naming the status in prose, every recognizer in the table reads a `code`, and
 * a platform shortage therefore reached the page as `500 Internal server
 * error`. Both halves have to be asserted at once or the next refactor
 * separates them again.
 */
describe("workflowApiErrorStatus on a platform reply", () => {
  const answering = (status: number): Promise<string> =>
    platformPost(
      {
        base: "https://platform.example/agent-1",
        token: "guest-token",
        fetch: async () => new Response("no connection available", { status }),
      },
      {
        route: PLATFORM_ROUTES.workflowJournal,
        label: "journal appendStep",
        timeoutMs: 1000,
        body: "{}",
      },
    );

  /**
   * What that call threw, so each case can ask the table about it.
   *
   * A non-2xx that RESOLVED comes back as a string rather than an `expect.fail`
   * — the assertion belongs in the case (Biome's `noMisplacedAssertion` says so,
   * and it is right: a helper that fails does not name which case failed). Every
   * case below rejects a string, the 4xx one through its `toBeInstanceOf` guard.
   */
  const thrownBy = async (status: number): Promise<unknown> =>
    await answering(status).then(
      (body) => `resolved with ${body}`,
      (err: unknown) => err,
    );

  test("a 503 answers 503 with a Retry-After, where it used to answer 500", async () => {
    const err = await thrownBy(503);
    // The MESSAGE is unchanged — it is still where a reader looks — and the
    // status is now machine-readable beside it.
    expect((err as Error).message).toContain("journal appendStep answered HTTP 503");
    expect(isPlatformUnavailable(err)).toBe(true);
    const mapped = workflowApiErrorStatus(err);
    if (mapped === false) expect.fail("a retryable platform reply must map to a status");
    expect(mapped).toMatchObject({ status: 503, retryAfter: "1" });
    // Names the PLATFORM, not the network between here and it: the operator
    // looking at this should be looking at a replica.
    expect(mapped.error).toContain("platform is at capacity");
  });

  test.each([408, 425, 429, 500, 502, 503, 504])(
    "a %d is retryable, the same set the upload path uses",
    async (status) => {
      expect(workflowApiErrorStatus(await thrownBy(status))).toMatchObject({ status: 503 });
    },
  );

  test.each([400, 401, 404, 409, 501])(
    "a %d stays a 500, because it will be the same answer next time",
    async (status) => {
      // The half that must NOT change: a 501 is a deployment without the
      // feature and a 404 is a run this agent does not own. Telling a page to
      // retry either is worse than the 500 it gets.
      const err = await thrownBy(status);
      expect(err).toBeInstanceOf(Error);
      expect(isPlatformUnavailable(err)).toBe(false);
      expect(workflowApiErrorStatus(err)).toBe(false);
    },
  );

  test("a caller's OWN error for a status wins, coded or not", async () => {
    // `errorFor` is how the storage 404 becomes a typed not-found and the upload
    // 409 becomes `claim` refusing an id — decisions the generic path must not
    // overwrite on its way past.
    const own = new Error("claim refused");
    await expect(
      platformPost(
        {
          base: "https://platform.example/agent-1",
          token: "guest-token",
          fetch: async () => new Response("", { status: 503 }),
        },
        {
          route: PLATFORM_ROUTES.uploadRecords,
          label: "upload-records claim",
          timeoutMs: 1000,
          body: "{}",
          errorFor: () => own,
        },
      ),
    ).rejects.toBe(own);
  });
});

/**
 * The same finding on the WIRE, because the classification is only half of it.
 *
 * `workflowApiErrorStatus` is a pure function and the tests above drive it
 * directly, which cannot see whether the router consults it, whether the header
 * is written, or whether the route has already sent its own head. This is the
 * answer a page actually receives.
 */
describe("what a failed platform read answers on the wire", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
  });

  /** The error a journal read raises when the platform is shedding load. */
  async function platformShortage(): Promise<unknown> {
    return await platformPost(
      {
        base: "https://platform.example/agent-1",
        token: "guest-token",
        fetch: async () => new Response("no connection available", { status: 503 }),
      },
      {
        route: PLATFORM_ROUTES.workflowJournal,
        label: "journal get",
        timeoutMs: 1000,
        body: "{}",
      },
    ).then(
      (body) => `resolved with ${body}`,
      (err: unknown) => err,
    );
  }

  test("GET /runs/:id/stream answers 503 with a Retry-After, where it answered 500", async () => {
    // The reported symptom, end to end: a long run's progress poll reads the
    // run, the platform is at capacity, and the page was told `500 Internal
    // server error` — which carries no `Retry-After` and reads as "this agent
    // is broken" rather than "come back in a second".
    const shortage = await platformShortage();
    expect(shortage).toBeInstanceOf(Error);
    harness = await serve({
      engine: () =>
        fakeClient({
          get: async () => {
            throw shortage;
          },
        }),
    });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(res.status).toBe(503);
    // The half a 500 could not carry, and the reason a fan-out of tabs does not
    // come back together into the shortage it is itself causing.
    expect(res.headers.get("Retry-After")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("platform is at capacity"),
    });
  });

  test("GET /runs/:id answers the same, so a poller and a reader agree", async () => {
    const shortage = await platformShortage();
    harness = await serve({
      engine: () =>
        fakeClient({
          get: async () => {
            throw shortage;
          },
        }),
    });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
  });
});
