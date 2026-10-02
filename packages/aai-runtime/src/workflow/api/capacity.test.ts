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
import { PLATFORM_ROUTES, platformPost } from "../../platform/index.ts";
import { fakeClient, type Harness, serve } from "./_test-utils.ts";
import { isPlatformUnavailable, workflowApiErrorStatus } from "./error-status.ts";

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
