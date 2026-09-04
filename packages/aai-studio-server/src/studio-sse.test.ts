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

import { sleep } from "@alexkroman1/aai/internal";
import { endLiveStreams, resetLiveStreams } from "aai-server/live-streams";
import type { SSEMessage } from "hono/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedReads, createSsePusher, type SseStream } from "./studio-sse.ts";

/**
 * Hono's SSE handle, reduced to what the pusher touches. `writeSSE` records
 * frames; `onAbort` captures the disconnect callback so a test can fire it.
 */
function makeStream(): {
  stream: SseStream;
  frames: { event?: string; data: string }[];
  abort: () => void;
} {
  const frames: { event?: string; data: string }[] = [];
  let onAbort = (): void => undefined;
  // Typed as `SseStream`, never cast to the whole `SSEStreamingApi`: the two
  // methods are what the pusher takes, so this is a real implementation of
  // that contract rather than a claim to be a class it is not.
  const stream: SseStream = {
    writeSSE: async (frame: SSEMessage) => {
      frames.push({ ...(frame.event && { event: frame.event }), data: String(frame.data) });
    },
    onAbort: (cb: () => void) => {
      onAbort = cb;
    },
  };
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

    // Through `push`, the only way to produce a frame — see `SsePusher`.
    sse.push(async () => ({ event: "project", data: "{}" }));
    await vi.advanceTimersByTimeAsync(0);
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
        if (slow) await sleep(50);
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

/**
 * The shared reader behind the event routes. Its job is that N streams
 * watching one row cost a fixed number of reads per change rather than N —
 * and that the registry backing it does not outlive the streams, since it is
 * a per-process map keyed by project and a studio serves unboundedly many.
 */
describe("createSharedReads", () => {
  it("serves one trailing read to every caller that joins while one is in flight", async () => {
    const shared = createSharedReads();
    let reads = 0;
    const gate = Promise.withResolvers<void>();
    const read = async () => {
      reads += 1;
      await gate.promise;
      return { event: "project", data: String(reads) };
    };
    const a = shared.acquire("scope proj", read);
    const b = shared.acquire("scope proj", read);
    const c = shared.acquire("scope proj", read);

    const first = a.trigger();
    const joined = [b.trigger(), c.trigger()];
    gate.resolve();
    await Promise.all([first, ...joined]);

    // Two reads, not one: a read that STARTED BEFORE a trigger cannot vouch
    // for that trigger's change, and the runner cannot know these triggers
    // came from the event it is already reading for. What matters is that the
    // count does not GROW with the caller count — the third joiner shares the
    // second's trailing read.
    expect(reads).toBe(2);
  });

  it("does not share between different rows", async () => {
    const shared = createSharedReads();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return { event: "project", data: "x" };
    };
    await shared.acquire("scope one", read).trigger();
    await shared.acquire("scope two", read).trigger();
    expect(reads).toBe(2);
    expect(shared.size()).toBe(2);
  });

  it("drops the entry when the last stream releases it", () => {
    const shared = createSharedReads();
    const read = async () => ({ event: "project", data: "x" });
    const a = shared.acquire("k", read);
    const b = shared.acquire("k", read);
    expect(shared.size()).toBe(1);

    a.release();
    // Still held by b — dropping on the first disconnect would leave the
    // remaining stream reading through a runner nothing else can join.
    expect(shared.size()).toBe(1);
    b.release();
    expect(shared.size()).toBe(0);

    // A double release must not decrement a successor's refcount: streams end
    // in more than one way (disconnect, shutdown drain, a null frame).
    a.release();
    const c = shared.acquire("k", read);
    expect(shared.size()).toBe(1);
    c.release();
    expect(shared.size()).toBe(0);
  });
});
