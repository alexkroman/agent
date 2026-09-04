// Copyright 2026 the AAI authors. MIT license.
/**
 * Inject a failure into the GUEST→SERVER hop and assert what the caller is
 * told — the same gate as `error-injection.test.ts`, one layer down.
 *
 * ## Why this needs its own sweep
 *
 * `workflow-api-error-classification.test.ts` already sweeps environmental
 * CODES against `workflowApiErrorStatus`, and it is a pure-function test: it
 * mints an error carrying a code and asks what status that code maps to. What
 * it cannot see is whether anything ever ATTACHES that code — and on this hop
 * exactly one thing does. `platform-rpc.ts`'s `statusError` puts
 * `PLATFORM_UNAVAILABLE_CODE` on a reply whose status is in `RETRYABLE_STATUS`
 * and on no other, so the entire "the platform said come back" branch of the
 * classification table is reachable only through that one `Set` membership
 * test.
 *
 * That is a seam with two ends and no test across it, and the failure it
 * produces has already shipped once: a platform route answering 503 arrived as
 * a plain `Error` whose only distinguishing feature was a sentence, every
 * recognizer declined it, and the browser was told **500 Internal server
 * error** — a permanent answer to a condition whose entire nature is that it
 * clears. Widening `RETRYABLE_STATUS`, narrowing it, or moving the attach would
 * reopen that with both existing suites green: the SDK's own upload retry loop
 * would keep passing (it reads the set directly) and the classification sweep
 * would keep passing (it mints the code by hand).
 *
 * So the corpus here is STATUSES rather than codes, every one is driven through
 * the real `platformPost` over an injected `fetch`, and the assertion is the
 * composition — what a page or a step is finally told.
 *
 * ## The rule is the same: there is no third state
 *
 * Every status a platform route can answer is declared `"retry"` or
 * `"permanent"` with a reason. A status in neither list fails the sweep, and a
 * `RETRYABLE_STATUS` member with no row fails it too — that second check is
 * what makes the two ends unable to drift apart quietly.
 */

import { RETRYABLE_STATUS } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { type PlatformCall, platformPost } from "./platform-rpc.ts";
import { workflowApiErrorStatus } from "./workflow-api-error-status.ts";

/** What the CALLER should be told when the platform answers this status. */
type Verdict =
  /** Transient: 503 with a `Retry-After`, so a client backs off and comes back. */
  | "retry"
  /**
   * Permanent: a 500 is right, because coming back produces the same answer.
   * Every entry carries the reason — silence is what the shipped 500 was.
   */
  | { readonly permanent: string };

/**
 * Statuses a platform route can really answer.
 *
 * Curated rather than generated, like `ENVIRONMENTAL_CODES` next door: the
 * point is to name the ones REACHABLE on this hop, so an entry has to be
 * arguable both ways. The five named in `platformPost`'s own doc (400, 401,
 * 404, 501, 503) are here, plus the upload-record 409, the queue and admin-pool
 * 5xx, and the timing family the SDK's retry set already covers.
 */
const PLATFORM_STATUSES: Readonly<Record<number, Verdict>> = {
  400: { permanent: "this guest built the call wrongly; the same body will be rejected again" },
  401: { permanent: "a bearer this sandbox no longer holds — a redeploy, not a wait, fixes it" },
  403: { permanent: "this sandbox's token does not authorize this slug" },
  404: { permanent: "a run or record this agent does not own; absence is stable" },
  405: { permanent: "a verb this route does not serve — a deployment mismatch" },
  408: "retry",
  409: {
    permanent:
      "the upload-record route's claim refusing an id, which is that backend WORKING — " +
      "the caller's own `errorFor` turns it into a typed refusal rather than a wait",
  },
  413: { permanent: "the body is too big; re-sending the same body cannot help" },
  425: "retry",
  429: "retry",
  500: "retry",
  501: { permanent: "a deployment without the feature; it will not appear on a retry" },
  502: "retry",
  503: "retry",
  504: "retry",
  507: {
    permanent:
      "the PLATFORM is out of storage. Classified permanent only because nothing here can " +
      "see it: `isDiskFull` reads an `ENOSPC` code off a thrown value and a 507 arrives as " +
      "a status, so this reaches the caller as a 500. That is arguably wrong — 507 is the " +
      "one status meaning exactly this — and it is recorded as a question rather than fixed, " +
      "because deciding it means deciding whether a platform 507 is retryable at all.",
  },
};

/** Injected `fetch`: answers `status` once, with a body the caller may read. */
function answering(status: number): PlatformEndpointFetch {
  return () =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify({ error: "injected" }), { status }),
    );
}

/** Injected `fetch`: rejects the way a failed hop out really does. */
function failingWith(code: string): PlatformEndpointFetch {
  return () =>
    Promise.reject(
      // `fetch` hands back a bare `TypeError: fetch failed` with the real code a
      // hop down — the shape `hasErrorCode`'s cause walk exists for, and the one
      // a top-level-only recognizer misses.
      new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }),
    );
}

/**
 * Exactly the seam `PlatformEndpoint` declares, derived rather than restated —
 * a hand-written signature here would drift from the one `platformPost` calls,
 * and the drift would be a compile error in the injector rather than a finding.
 */
type PlatformEndpointFetch = NonNullable<PlatformEndpoint["fetch"]>;

const CALL: PlatformCall = {
  route: PLATFORM_ROUTES.sessionState,
  label: "session-state load",
  timeoutMs: 5000,
  body: "{}",
};

/** Drive the real `platformPost` over `fetchFn` and classify what it throws. */
async function classify(
  fetchFn: PlatformEndpointFetch,
  call: PlatformCall = CALL,
): Promise<ReturnType<typeof workflowApiErrorStatus>> {
  try {
    await platformPost({ base: "https://platform.test/slug", token: "t", fetch: fetchFn }, call);
  } catch (err: unknown) {
    return workflowApiErrorStatus(err);
  }
  // A plain throw rather than `expect.fail`: an assertion outside a test body is
  // `noMisplacedAssertion`, and the failure is reported the same either way.
  throw new Error("platformPost resolved; the injected fault produced no error at all");
}

describe("every platform status the guest can meet is classified", () => {
  /**
   * The sweep proper. Both branches are asserted, not just the retry one: a
   * classifier that became a blanket yes would pass a retry-only check while
   * telling a client to re-issue a 400 forever.
   */
  test.each(Object.entries(PLATFORM_STATUSES))("HTTP %s", async (raw, verdict) => {
    const status = Number(raw);
    const answer = await classify(answering(status));
    if (verdict === "retry") {
      expect(
        answer,
        `a platform ${status} must reach the caller as a 503 with a Retry-After. It does ` +
          "not, which means `statusError` is no longer attaching PLATFORM_UNAVAILABLE_CODE " +
          "for this status — the exact regression that once made a platform 503 a browser 500.",
      ).toMatchObject({ status: 503, retryAfter: "1" });
    } else {
      expect(
        answer,
        `a platform ${status} is declared permanent (${verdict.permanent}), so it must NOT ` +
          "be dressed up as retryable — a client told to come back to a stable refusal " +
          "retries it forever.",
      ).toBe(false);
    }
  });

  /**
   * The two ends may not drift.
   *
   * `RETRYABLE_STATUS` is the SDK's set and this table is the guest's reading of
   * it; a status added there with no row here is a condition nobody classified,
   * which is the shape of the shipped bug this file exists for.
   */
  test("every RETRYABLE_STATUS member has a row, and it says retry", () => {
    for (const status of RETRYABLE_STATUS) {
      expect(
        PLATFORM_STATUSES[status],
        `${status} is in RETRYABLE_STATUS and has no row here, so nothing checks that the ` +
          "guest passes the platform's own 'come back' decision on to its caller.",
      ).toBe("retry");
    }
  });

  /** And the reverse: a row claiming retry that the SDK does not consider one. */
  test("no row claims retry for a status RETRYABLE_STATUS excludes", () => {
    for (const [raw, verdict] of Object.entries(PLATFORM_STATUSES)) {
      if (verdict !== "retry") continue;
      expect(RETRYABLE_STATUS.has(Number(raw)), `${raw} claims retry but the SDK disagrees`).toBe(
        true,
      );
    }
  });

  /** Every permanent entry states a reason, and it has to be a real one. */
  test("no permanent entry is a bare assertion", () => {
    for (const [status, verdict] of Object.entries(PLATFORM_STATUSES)) {
      if (verdict === "retry") continue;
      expect(verdict.permanent.length, `${status} needs a real reason`).toBeGreaterThan(40);
    }
  });

  /** The corpus floor: a sweep whose table emptied prints the same green. */
  test("the sweep covers a corpus", () => {
    expect(Object.keys(PLATFORM_STATUSES).length).toBeGreaterThan(12);
    expect(RETRYABLE_STATUS.size).toBeGreaterThan(5);
  });
});

describe("a failed hop out of the guest", () => {
  /**
   * The other half of this seam. A platform call that never gets an answer is
   * the case `_egress-fetch.ts` exists for — a reset taken by one request
   * failing every sibling on the same HTTP/2 connection — and the production
   * symptom was six consecutive `500 Internal server error`s, each ~40s, each
   * making the browser re-send windows it had already stored, into the fault.
   */
  test.each(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "EAI_AGAIN"])(
    "%s reaches the caller as a 503, not a 500",
    async (code) => {
      expect(await classify(failingWith(code))).toMatchObject({ status: 503, retryAfter: "1" });
    },
  );

  /**
   * `ENOTFOUND` is the deliberate exclusion, asserted so the exclusion cannot
   * quietly become an oversight: a hostname that does not resolve is
   * configuration, and "retry shortly" would hide a permanent fault behind a
   * client's loop forever.
   */
  test("ENOTFOUND stays a 500 — config is not weather", async () => {
    expect(await classify(failingWith("ENOTFOUND"))).toBe(false);
  });

  /**
   * A DEADLINE that elapses is a third condition, and it is classified by
   * nothing.
   *
   * `platformPost` wraps every call in `pTimeout`, whose rejection is a
   * `TimeoutError` carrying no `code` — so it reaches the classification table
   * as an unrecognized value and the caller is told the agent is broken. It is
   * the same condition as the transport failures above (the platform did not
   * answer in time) with the opposite verdict, and the four deadlines are 10s,
   * 15s, 15s and 20s, i.e. long enough that elapsing one means the platform is
   * struggling rather than absent.
   *
   * Pinned as the CURRENT behaviour with the gap named, not "fixed" by guessing:
   * making it a 503 is a one-line recognizer, and whether a guest should tell a
   * page to re-issue a call it may have already half-applied is a decision about
   * idempotency that this test cannot make.
   */
  test("a timed-out platform call is NOT classified — a known gap", async () => {
    const never: PlatformEndpointFetch = () => new Promise(() => undefined);
    const answer = await classify(never, { ...CALL, timeoutMs: 5 });
    expect(
      answer,
      "if this now maps to a status, the gap was closed — delete this test and the " +
        "paragraph above it rather than updating the expectation.",
    ).toBe(false);
  });
});
