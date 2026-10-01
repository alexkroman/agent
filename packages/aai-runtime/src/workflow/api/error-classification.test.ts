// Copyright 2026 the AAI authors. MIT license.
/**
 * Every environmental error reaching the workflow API is CLASSIFIED.
 *
 * ## The defect class
 *
 * Two separate "500 that should have been a 503" bugs were fixed in one 48-hour
 * window, each at the site that produced it: a `fetch` rejecting with
 * `TypeError: fetch failed` on a part claim, and an exhausted Postgres pool on
 * `POST /runs`. Both had the same shape — an error that came from the
 * ENVIRONMENT arrived at the router as an unnamed rejection, and the router's
 * only answer for a value it does not recognise is `500 Internal server error`.
 *
 * A 500 is wrong on three counts the classification table is about: it says the
 * agent is broken when the agent is fine, it tells an operator nothing, and it
 * carries no `Retry-After`, so a whole fan-out comes back at once into the same
 * fault.
 *
 * Fixing them one site at a time leaves the class open. This file closes it: it
 * enumerates the environmental error codes a Node service can actually meet and
 * requires that {@link workflowApiErrorStatus} have an ANSWER for each one —
 * either a mapped status, or an entry in {@link DELIBERATELY_INTERNAL} saying
 * out loud why a 500 is right. There is no third state, which is the whole
 * point: "we never thought about this code" is what both production bugs were.
 *
 * ## Why a test and not a runtime invariant
 *
 * The natural home for this is an `invariant()` at the 500 boundary. It is
 * deliberately NOT there: that boundary is an error handler, so a throw inside it
 * turns a 500 into an unhandled rejection, and an oracle whose purpose is to find
 * things nobody has classified yet is exactly the one you do not want failing
 * that way in production the first time it is right.
 *
 * `workflowApiErrorStatus` is a PURE FUNCTION of a thrown value, so the whole
 * property is checkable with no process at all — which is strictly better than a
 * sampled runtime check: it covers codes production has not met yet.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { workflowApiErrorStatus } from "./error-status.ts";
import { isCallerGone } from "./http.ts";

/**
 * Environmental codes a Node service on this platform can actually be handed.
 *
 * libuv errnos, undici's own, node's HTTP/2 set, and the DNS pair. Curated
 * rather than generated: the point is to name the ones that are REACHABLE here,
 * so an entry has to be arguable both ways.
 */
const ENVIRONMENTAL_CODES = [
  // libuv, the socket
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENOTCONN",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  // DNS
  "EAI_AGAIN",
  "ENOTFOUND",
  // resource exhaustion, which is the interesting group
  "EMFILE",
  "ENFILE",
  "ENOBUFS",
  "ENOMEM",
  "EAGAIN",
  "ENOSPC",
  // undici
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_RESPONSE_STATUS_CODE",
  // node http2
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
] as const;

/**
 * Codes a 500 is the RIGHT answer for, each with the reason.
 *
 * This is the classification half. An entry here is a decision that the
 * condition is a fault in this agent or its configuration — something an
 * operator must fix, not something a client should retry — so telling the
 * caller "the agent is broken" is accurate.
 *
 * **Adding an entry is the point of the exercise, not a way around the test.**
 * What it may never be is silence: a code that is in neither this map nor the
 * classifier is one nobody has thought about, and that is what both production
 * 500s were.
 */
const DELIBERATELY_INTERNAL: Readonly<Record<string, string>> = {
  // A hostname that does not resolve is a misconfiguration. Answering "retry
  // shortly" would hide a permanent fault behind a client's retry loop forever —
  // `TRANSPORT_FAILURE_CODES` names this exclusion explicitly, and `EAI_AGAIN`
  // (the TEMPORARY DNS failure) is mapped for the mirror-image reason.
  ENOTFOUND: "a hostname that does not resolve is config, not weather",
  // This process binding a port it cannot have is a deployment fault; no client
  // retry helps, and it cannot happen mid-request on a served route.
  EADDRINUSE: "binding a taken port is a deployment fault",
  EADDRNOTAVAIL: "binding an address this host does not have is a deployment fault",
  // undici raises this when a RESPONSE arrived and its status was rejected — so
  // the hop out succeeded and there is nothing transient to wait for. Whatever
  // built that request asked for a status the peer will keep returning.
  UND_ERR_RESPONSE_STATUS_CODE: "a response arrived; its status is not a transport fault",
};

/** Build a realistic error: the code is almost never on the value thrown. */
function errorWithCode(code: string, depth: number, onSyscall: boolean): unknown {
  const leaf = Object.assign(
    new Error(`${code} something failed`),
    onSyscall ? { code, syscall: "connect", errno: -1 } : { code },
  );
  let cur: unknown = leaf;
  for (let i = 0; i < depth; i += 1) {
    // What `fetch` really hands back: a bare `TypeError: fetch failed` whose
    // `cause` carries the code, sometimes two hops down.
    cur = new TypeError("fetch failed", { cause: cur });
  }
  return cur;
}

describe("every environmental code has an answer", () => {
  /**
   * The class sweep. A code is classified when the mapper gives it a status, and
   * otherwise must be named in {@link DELIBERATELY_INTERNAL} with a reason.
   */
  test.each(ENVIRONMENTAL_CODES)("%s is classified", (code) => {
    const mapped = workflowApiErrorStatus(errorWithCode(code, 1, true));
    const declared = DELIBERATELY_INTERNAL[code];
    expect(
      mapped !== false || typeof declared === "string",
      `${code} falls through to 500 and is not declared in DELIBERATELY_INTERNAL. ` +
        "Either map it to a status, or add an entry saying why the agent really is " +
        "the broken thing. Silence is what both production 500s were.",
    ).toBe(true);
  });

  /**
   * A classification must not depend on HOW DEEP the code is wrapped, and this
   * is the half that has actually broken: the code is almost never on the value
   * that was thrown, so a recognizer reading only the top level reports nothing
   * for the shape production really produces.
   *
   * Every code, ECONNRESET included. Depth is the only thing varied against the
   * bare value: whether the leaf names a `syscall` is held fixed, because for a
   * reset it is the DIRECTION (below), and for every other code the next test
   * asserts it changes nothing.
   */
  test("depth does not change a verdict", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENVIRONMENTAL_CODES),
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(),
        (code, depth, onSyscall) => {
          const bare = workflowApiErrorStatus(errorWithCode(code, 0, onSyscall));
          const nested = workflowApiErrorStatus(errorWithCode(code, depth, onSyscall));
          expect(nested).toEqual(bare);
        },
      ),
      { numRuns: 400 },
    );
  });

  test("shape does not change a verdict, except a reset's direction", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENVIRONMENTAL_CODES.filter((c) => c !== "ECONNRESET")),
        fc.integer({ min: 0, max: 4 }),
        (code, depth) => {
          expect(workflowApiErrorStatus(errorWithCode(code, depth, false))).toEqual(
            workflowApiErrorStatus(errorWithCode(code, depth, true)),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * ECONNRESET is the one code whose verdict depends on WHICH WAY the socket
   * went, and the two answers are both classified — there is still no third
   * state.
   *
   * Node's inbound request error (`aborted`, the caller hung up) carries
   * `ECONNRESET` and no `syscall`; an OUTBOUND reset — `fetch`'s cause, or a
   * `postgres` driver's top-level socket error — is a libuv errno naming the
   * `syscall` that failed (`read`, measured on Node 24). `isCallerGone` reads
   * that off the INNERMOST cause, so a hangup is dropped (no status: the socket a
   * 503 would be written to is the one that closed) and an outbound reset is a
   * 503 with `Retry-After`, at every depth. It used to read the top-level value,
   * which made wrapping decide instead: a bare outbound reset was dropped as a
   * hangup — a real client on `POST /runs` would have lost its socket — while the
   * same reset wrapped by `fetch` was a 503.
   */
  test.each([0, 1, 2, 3])("ECONNRESET is classified by direction at depth %i", (depth) => {
    const inbound = workflowApiErrorStatus(errorWithCode("ECONNRESET", depth, false));
    const outbound = workflowApiErrorStatus(errorWithCode("ECONNRESET", depth, true));
    expect(inbound, "an inbound reset is the caller hanging up").toBe(false);
    expect(isCallerGone(errorWithCode("ECONNRESET", depth, false))).toBe(true);
    expect(outbound, "an outbound reset is a transport failure").toMatchObject({
      status: 503,
      retryAfter: "1",
    });
    expect(isCallerGone(errorWithCode("ECONNRESET", depth, true))).toBe(false);
  });

  /**
   * The recognizer must not walk forever on a cycle, which a `cause` chain can
   * genuinely be: two errors each wrapping the other is what a retry wrapper that
   * re-throws its own cause produces.
   */
  test("a cyclic cause chain terminates", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b;
    expect(() => workflowApiErrorStatus(a)).not.toThrow();
  });

  /**
   * The other direction, so the sweep cannot pass by the mapper becoming a
   * blanket yes: an ordinary bug is NOT environmental and must still be a 500.
   */
  test.each([
    ["a plain TypeError", new TypeError("x is not a function")],
    ["a bare Error", new Error("boom")],
    ["a thrown string", "boom"],
    ["a thrown object with no code", { message: "boom" }],
    ["an error with a non-environmental code", Object.assign(new Error("x"), { code: "EBADF" })],
  ])("%s is still a 500", (_label, err) => {
    expect(workflowApiErrorStatus(err)).toBe(false);
  });

  /** Nothing in the declared map may be dead — an entry the mapper now handles. */
  test("no DELIBERATELY_INTERNAL entry is stale", () => {
    for (const [code, reason] of Object.entries(DELIBERATELY_INTERNAL)) {
      expect(reason.length, `${code} needs a real reason`).toBeGreaterThan(10);
      expect(
        workflowApiErrorStatus(errorWithCode(code, 1, true)),
        `${code} is now MAPPED by the classifier, so its DELIBERATELY_INTERNAL entry ` +
          "is stale and says the opposite of what the code does. Remove it.",
      ).toBe(false);
    }
  });

  /** The corpus floor: a sweep whose list emptied would print the same green. */
  test("the sweep actually covers a corpus", () => {
    expect(ENVIRONMENTAL_CODES.length).toBeGreaterThan(25);
  });
});
