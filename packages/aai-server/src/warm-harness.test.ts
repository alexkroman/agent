// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the shared guest-harness wiring: stdio draining (log cap
 * included). The guest WebSocket dial and the agent boot env moved beside
 * their modules (`guest/dial.test.ts`, `guest/boot-env.test.ts`).
 * The WarmHarness lifecycle itself (exit fan-out, memoized cleanup) is
 * exercised through both backends' suites — modal/sandbox.test.ts and
 * subprocess-sandbox.test.ts.
 */

import { describe, expect, it } from "vitest";
import { captureLogs } from "./_logger-test-utils.ts";
import { drainProcStream } from "./warm-harness.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

describe("drainProcStream", () => {
  const logs = captureLogs();
  it("logs guest output under the label and skips blank chunks", async () => {
    await drainProcStream(streamOf(["boom at line 3\n", "   \n"]), "[container:x] stderr");
    expect(logs.warns()).toEqual(["guest [container:x] stderr: boom at line 3"]);
  });

  it("stops logging past the byte cap but keeps draining to stream end", async () => {
    const big = "x".repeat(64 * 1024); // one chunk exhausts the cap
    await expect(drainProcStream(streamOf([big, "after the cap"]), "[l]")).resolves.toBeUndefined();
    expect(logs.warns()).toHaveLength(1); // the capped chunk only
  });

  it("swallows a stream that errors mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("peer died"));
      },
    });
    await expect(drainProcStream(stream, "[l]")).resolves.toBeUndefined();
  });
});
