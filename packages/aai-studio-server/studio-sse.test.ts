// Copyright 2026 the AAI authors. MIT license.
/**
 * The event streams' lifecycle. Three properties, each of which fails
 * invisibly: an ended stream must stop writing (a heartbeat into a closed
 * response throws every 25s forever), a burst must deliver in order (a turn's
 * file sync then the preview stamp, where the slower producer would otherwise
 * land last and push a stale snapshot), and a vanished row must end the stream
 * rather than hold the connection.
 *
 * The wire-level half — that an ended stream terminates its chunked body
 * instead of being cut mid-frame — lives in aai-server/live-streams.test.ts,
 * which reads raw socket bytes the way Modal's ASGI proxy parser does.
 */

import { endLiveStreams, resetLiveStreams } from "aai-server/live-streams";
import type { SSEStreamingApi } from "hono/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSsePusher } from "./studio-sse.ts";

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
  it("holds open indefinitely while the client is there", async () => {
    const { stream, frames } = makeStream();
    const sse = createSsePusher(stream);
    let cleaned = false;
    const held = sse.wait(() => {
      cleaned = true;
    });

    // A subscription lives as long as the project is on screen — hours. Only a
    // disconnect, a null push, or shutdown ends one; nothing here expires it.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(cleaned).toBe(false);
    expect(frames.filter((f) => f.event === "ping").length).toBeGreaterThan(0);

    endLiveStreams();
    await held;
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
    // The interval is cleared on the way out; left armed, it would write into a
    // closed response every 25s for the life of the process.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
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

    endLiveStreams();
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
