// Copyright 2026 the AAI authors. MIT license.
/**
 * The live-response registry shutdown drains, so `process.exit` cannot destroy
 * a stream mid-body.
 *
 * Pure-memory semantics only. The WIRE-level half — a real port, a real chunked
 * body, and its terminating `0\r\n\r\n` — is `live-streams.scenario.test.ts`:
 * binding a port puts a test in the scenario tier (AGENTS.md, "Test tiers"),
 * and it used to sit here under the unit tier's rules.
 */

import { afterEach, describe, expect, test } from "vitest";
import { MAX_LIVE_STREAMS_PER_SCOPE } from "./constants.ts";
import {
  endLiveStreams,
  liveStreamCount,
  registerLiveStream,
  reservedLiveStreams,
  reserveLiveStream,
  resetLiveStreams,
} from "./live-streams.ts";

afterEach(() => {
  // Drops the shutdown latch too — without the reset, the first test to call
  // endLiveStreams() would leave every later one registering into a closed
  // registry.
  resetLiveStreams();
});

describe("registry", () => {
  test("ends every registered stream and reports the count", () => {
    const ended: string[] = [];
    registerLiveStream(() => ended.push("a"));
    registerLiveStream(() => ended.push("b"));
    expect(endLiveStreams()).toBe(2);
    expect(ended).toEqual(["a", "b"]);
    // Drained, so a second shutdown pass ends nothing twice.
    expect(endLiveStreams()).toBe(0);
  });

  test("a stream that ended on its own deregisters", () => {
    const unregister = registerLiveStream(() => {
      throw new Error("must not run for a settled stream");
    });
    unregister();
    expect(liveStreamCount()).toBe(0);
    expect(endLiveStreams()).toBe(0);
  });

  test("a stream registered after shutdown ends immediately", () => {
    // The reconnect case: the client's first backoff is 3s and shutdown keeps
    // serving for SHUTDOWN_GRACE_MS, so a resubscribe lands here mid-shutdown
    // routinely. Registering it would hold it open until the process exit cut
    // it mid-chunk — the very truncation the registry exists to prevent.
    endLiveStreams();
    let ended = false;
    const unregister = registerLiveStream(() => {
      ended = true;
    });
    expect(ended).toBe(true);
    // Not registered, so a later drain pass cannot end it a second time.
    expect(liveStreamCount()).toBe(0);
    expect(endLiveStreams()).toBe(0);
    // And its deregistration is still safe to call as the stream settles.
    expect(() => unregister()).not.toThrow();
  });

  test("one ender that throws does not strand the others", () => {
    let reached = false;
    registerLiveStream(() => {
      throw new Error("boom");
    });
    registerLiveStream(() => {
      reached = true;
    });
    expect(endLiveStreams()).toBe(2);
    expect(reached).toBe(true);
  });
});

describe("per-scope reservations", () => {
  test("hands out slots up to the cap, then refuses", () => {
    const slots = Array.from({ length: MAX_LIVE_STREAMS_PER_SCOPE }, () =>
      reserveLiveStream("scope-a"),
    );
    expect(slots.every((s) => s !== null)).toBe(true);
    expect(reservedLiveStreams("scope-a")).toBe(MAX_LIVE_STREAMS_PER_SCOPE);
    // The refusal is the whole point: the route turns null into a 429 rather
    // than becoming a stream it cannot account for.
    expect(reserveLiveStream("scope-a")).toBeNull();
  });

  test("a release frees exactly one slot", () => {
    const first = reserveLiveStream("scope-a");
    for (let i = 1; i < MAX_LIVE_STREAMS_PER_SCOPE; i++) reserveLiveStream("scope-a");
    expect(reserveLiveStream("scope-a")).toBeNull();

    first?.();

    expect(reservedLiveStreams("scope-a")).toBe(MAX_LIVE_STREAMS_PER_SCOPE - 1);
    expect(reserveLiveStream("scope-a")).not.toBeNull();
  });

  test("releasing twice frees only one slot", () => {
    // Both cleanup paths can run (`stream.onAbort` beside the `finally`), so a
    // non-idempotent release would decrement a slot this caller no longer owns
    // — surfacing much later as a scope that can never reach its cap.
    const slot = reserveLiveStream("scope-a");
    reserveLiveStream("scope-a");
    slot?.();
    slot?.();
    expect(reservedLiveStreams("scope-a")).toBe(1);
  });

  test("scopes are counted independently", () => {
    for (let i = 0; i < MAX_LIVE_STREAMS_PER_SCOPE; i++) reserveLiveStream("scope-a");
    expect(reserveLiveStream("scope-a")).toBeNull();
    // One abusive caller must not refuse everybody else.
    expect(reserveLiveStream("scope-b")).not.toBeNull();
  });

  test("a fully released scope leaves no entry behind", () => {
    // The keys are caller scopes, so an entry retained at 0 is a slow leak
    // keyed by user identity.
    const slot = reserveLiveStream("scope-a");
    expect(reservedLiveStreams("scope-a")).toBe(1);
    slot?.();
    expect(reservedLiveStreams("scope-a")).toBe(0);
  });

  test("reservations are independent of the shutdown registry", () => {
    // Two different jobs: one refuses new streams, the other ends live ones.
    // A reservation is not a registration, so shutdown must not report it.
    reserveLiveStream("scope-a");
    expect(liveStreamCount()).toBe(0);
    expect(endLiveStreams()).toBe(0);
  });
});
