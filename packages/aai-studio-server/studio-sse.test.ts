// Copyright 2026 the AAI authors. MIT license.
/**
 * The event streams' lifecycle: they must end THEMSELVES before any
 * intermediary cuts them mid-body.
 *
 * On Modal a long-lived response is one input, so the studio app's function
 * timeout bounds a stream's whole lifetime — and a stream reaped there is
 * truncated, which the ASGI proxy reports as `ClientPayloadError: ...
 * TransferEncodingError`. See SSE_MAX_STREAM_MS.
 */

import { resetLiveStreams } from "aai-server/live-streams";
import type { SSEStreamingApi } from "hono/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSsePusher, SSE_MAX_STREAM_MS } from "./studio-sse.ts";

/**
 * Hono's SSE handle, reduced to what the pusher touches. `writeSSE` records
 * frames; `onAbort` captures the disconnect callback so a test can fire it.
 */
function makeStream(): {
  stream: SSEStreamingApi;
  frames: { event?: string; data: string }[];
  abort: () => void;
} {
  const frames: { event?: string; data: string }[] = [];
  let onAbort = (): void => undefined;
  const stream = {
    writeSSE: async (frame: { event?: string; data: string }) => {
      frames.push(frame);
    },
    onAbort: (cb: () => void) => {
      onAbort = cb;
    },
  } as unknown as SSEStreamingApi;
  return { stream, frames, abort: () => onAbort() };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetLiveStreams();
});

afterEach(() => {
  vi.useRealTimers();
  resetLiveStreams();
});

describe("createSsePusher", () => {
  it("ends the stream itself once it reaches the lifetime cap", async () => {
    const { stream } = makeStream();
    const sse = createSsePusher(stream);
    let cleaned = false;
    const held = sse.wait(() => {
      cleaned = true;
    });

    // Still open well past the heartbeat interval — the cap is not a timeout on
    // an idle stream, it is a ceiling on a healthy one.
    await vi.advanceTimersByTimeAsync(SSE_MAX_STREAM_MS - 1000);
    expect(cleaned).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await held;
    // Resolving `wait` is what returns the route handler, which is what lets
    // hono terminate the chunked body — the client then resubscribes and its
    // first frame is current state again.
    expect(cleaned).toBe(true);
  });

  it("stops heartbeating once the stream has ended", async () => {
    const { stream, frames, abort } = makeStream();
    const sse = createSsePusher(stream);
    const held = sse.wait(() => undefined);

    await vi.advanceTimersByTimeAsync(60_000);
    const beats = frames.filter((f) => f.event === "ping").length;
    expect(beats).toBeGreaterThan(0);

    abort();
    await held;
    // Both timers are cleared on the way out; a fired lifetime timer after the
    // response is gone would be a write to a closed stream every 25s.
    await vi.advanceTimersByTimeAsync(SSE_MAX_STREAM_MS * 2);
    expect(frames.filter((f) => f.event === "ping").length).toBe(beats);
  });

  it("writes nothing after the stream has ended", async () => {
    const { stream, frames, abort } = makeStream();
    const sse = createSsePusher(stream);
    const held = sse.wait(() => undefined);

    abort();
    await held;

    await sse.write("project", "{}");
    expect(frames.filter((f) => f.event === "project")).toEqual([]);
  });

  it("serializes pushes so a burst cannot deliver an older snapshot last", async () => {
    const { stream, frames } = makeStream();
    const sse = createSsePusher(stream);
    const held = sse.wait(() => undefined);

    // The realistic burst: a turn's file sync, then the preview stamp. The
    // first producer is slower, so unserialized reads would land out of order.
    let first = true;
    for (const data of ["older", "newer"]) {
      sse.push(async () => {
        const slow = first;
        first = false;
        if (slow) await new Promise((r) => setTimeout(r, 50));
        return { event: "project", data };
      });
    }

    await vi.advanceTimersByTimeAsync(100);
    expect(frames.filter((f) => f.event === "project").map((f) => f.data)).toEqual([
      "older",
      "newer",
    ]);

    await vi.advanceTimersByTimeAsync(SSE_MAX_STREAM_MS);
    await held;
  });

  it("a null push ends the stream — the watched row is gone", async () => {
    const { stream } = makeStream();
    const sse = createSsePusher(stream);
    let cleaned = false;
    const held = sse.wait(() => {
      cleaned = true;
    });

    sse.push(async () => null);
    await vi.advanceTimersByTimeAsync(0);
    await held;
    expect(cleaned).toBe(true);
  });
});
