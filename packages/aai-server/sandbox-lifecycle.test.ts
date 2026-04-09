// Copyright 2025 the AAI authors. MIT license.
/**
 * Regression test: shutting down one isolate must not break the shared V8
 * runtime for other isolates.
 *
 * Bug: `runtime.terminate()` calls `releaseSharedV8Runtime()` which kills the
 * shared Rust V8 process when the reference count hits zero. Terminating the
 * last active isolate kills the Rust process, causing "broken pipe" errors for
 * subsequent isolate boots.
 *
 * Fix: sandbox shutdown uses `channel.shutdown()` instead of `runtime.terminate()`.
 *
 * NOTE: This test must run under the integration config (not unit tests) because
 * secure-exec V8 isolates require `pool: "threads"` (the default). The unit test
 * config uses `pool: "forks"` which is incompatible with secure-exec's child
 * process management.
 */

import { afterAll, describe, expect, test } from "vitest";
import { _internals } from "./sandbox.ts";
import { createMockKv } from "./test-utils.ts";

const BUNDLE_A = `
export default {
  name: "agent-a",
  systemPrompt: "A",
  greeting: "",
  maxSteps: 1,
  tools: { ping: { description: "Ping", execute() { return "pong-a"; } } },
};
`;

const BUNDLE_B = `
export default {
  name: "agent-b",
  systemPrompt: "B",
  greeting: "",
  maxSteps: 1,
  tools: { ping: { description: "Ping", execute() { return "pong-b"; } } },
};
`;

describe("isolate lifecycle", () => {
  const handles: Awaited<ReturnType<typeof _internals.startIsolate>>[] = [];

  afterAll(async () => {
    for (const h of handles) {
      h.channel.shutdown();
    }
  });

  test("shutting down one isolate does not break subsequent boots", async () => {
    // Boot isolate A
    const isolateA = await _internals.startIsolate(BUNDLE_A, createMockKv(), {});

    // Verify A works
    const resultA = await isolateA.channel.call<{ result: string }>(
      { type: "tool", name: "ping", sessionId: "s1", args: {}, messages: [] },
      5000,
    );
    expect(resultA.result).toBe("pong-a");

    // Shut down A's channel (safe shutdown — no runtime.terminate())
    isolateA.channel.shutdown();

    // Boot isolate B — should work cleanly
    const isolateB = await _internals.startIsolate(BUNDLE_B, createMockKv(), {});
    handles.push(isolateB);

    const resultB = await isolateB.channel.call<{ result: string }>(
      { type: "tool", name: "ping", sessionId: "s2", args: {}, messages: [] },
      5000,
    );
    expect(resultB.result).toBe("pong-b");
  });

  test("multiple sequential boot-shutdown cycles work", async () => {
    for (let i = 0; i < 3; i++) {
      const isolate = await _internals.startIsolate(BUNDLE_A, createMockKv(), {});
      const result = await isolate.channel.call<{ result: string }>(
        { type: "tool", name: "ping", sessionId: `c-${i}`, args: {}, messages: [] },
        15_000,
      );
      expect(result.result).toBe("pong-a");
      isolate.channel.shutdown();
    }
  }, 60_000);
});
