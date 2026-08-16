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
import {
  endLiveStreams,
  liveStreamCount,
  registerLiveStream,
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
