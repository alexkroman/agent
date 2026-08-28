// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /:slug/workflow-stream` — the live read.
 *
 * Three properties carry it, and none is visible in a diff:
 *
 * - **The name the world is asked for is built from the AUTHENTICATED slug.** This
 *   is the one Streamer method with no run id, so the qualification IS the tenant
 *   boundary — there is nothing to check ownership of. What must be true is that a
 *   caller cannot influence the prefix.
 * - **The body is the stream**, live. A handler that buffered it into an array
 *   would pass every "does it return the bytes" assertion and destroy the feature.
 * - **The response is bounded**, and the timer is released on every natural end. A
 *   `setTimeout` per read that outlives its stream is the leak the bound exists to
 *   prevent.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { bearerFor, createTestOrchestrator, type TestFetch } from "./test-utils.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";
import { STREAM_READ_MAX_MS } from "./workflow-stream-handler.ts";

const MINE = "mine-agent";

/** A world whose `readFromStream` records its arguments and yields what it is given. */
function fakeWorld(
  chunks: (Uint8Array | string)[] = [],
  opts: { live?: boolean } = {},
): PlatformWorldStorage & { asked: { name: string; startIndex?: number }[] } {
  const asked: { name: string; startIndex?: number }[] = [];
  return {
    asked,
    runs: {},
    steps: {},
    events: {},
    hooks: {},
    streamer: {
      readFromStream: (name: string, startIndex?: number) => {
        asked.push({ name, ...omitUndefined({ startIndex }) });
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(
                  typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
                );
              }
              // `live: true` leaves it OPEN, which is what a stream whose run has
              // not written its EOF looks like.
              if (!opts.live) controller.close();
            },
          }),
        );
      },
    },
    close: () => Promise.resolve(),
  };
}

async function platform(world = fakeWorld()) {
  const harness = await createTestOrchestrator({ runStorage: world });
  const res = await harness.fetch("/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: MINE,
      env: { ASSEMBLYAI_API_KEY: "k" },
      worker:
        'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
      clientFiles: {},
    }),
  });
  if (!res.ok) throw new Error(`deploy answered ${res.status}`);
  return { ...harness, world };
}

function read(fetch: TestFetch, query: string, bearer?: string, slug = MINE): Promise<Response> {
  const authorization = bearer === undefined ? undefined : `Bearer ${bearer}`;
  return fetch(`/${slug}/workflow-stream${query}`, {
    headers: { ...omitUndefined({ authorization }) },
  });
}

describe("GET /:slug/workflow-stream", () => {
  describe("the tenant boundary, which is the NAME", () => {
    /**
     * The assertion that makes this route safe.
     *
     * `readFromStream` has no run id, so there is nothing to check — the prefix is
     * the whole boundary. It comes from the bearer that was just verified, so a
     * caller can only ever name `<their-slug>/<name>`.
     */
    test("asks the world for the name qualified with the AUTHENTICATED slug", async () => {
      const p = await platform();
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(res.status).toBe(200);
      expect(p.world.asked).toEqual([{ name: `${MINE}/output` }]);
    });

    test("a caller cannot influence the prefix by naming another agent", async () => {
      // The forgery attempt: ask for `theirs/output`. It becomes
      // `mine-agent/theirs/output`, which is this agent's own namespace.
      const p = await platform();
      await read(p.fetch, "?name=theirs%2Foutput", await bearerFor(p.store, MINE));
      expect(p.world.asked[0]?.name).toBe(`${MINE}/theirs/output`);
    });

    test.each([
      ["no bearer", undefined],
      ["a guessed token", "0".repeat(64)],
    ])("refuses %s, and asks the world nothing", async (_label, bearer) => {
      const p = await platform();
      const res = await read(p.fetch, "?name=output", bearer);
      expect(res.status).toBe(401);
      expect(p.world.asked).toEqual([]);
    });
  });

  describe("the request", () => {
    test("requires a name", async () => {
      const p = await platform();
      const res = await read(p.fetch, "", await bearerFor(p.store, MINE));
      expect(res.status).toBe(400);
      expect(p.world.asked).toEqual([]);
    });

    /**
     * A NEGATIVE `startIndex` is legal and load-bearing: their doc says it starts
     * that many chunks before the current end, which is how a reconnecting reader
     * asks for "the last few". Rejecting it would break the reconnect this route's
     * own bound depends on.
     */
    test.each([
      ["0", 0],
      ["12", 12],
      ["-3", -3],
    ])("passes startIndex %s through", async (raw, expected) => {
      const p = await platform();
      await read(p.fetch, `?name=output&startIndex=${raw}`, await bearerFor(p.store, MINE));
      expect(p.world.asked[0]?.startIndex).toBe(expected);
    });

    test.each(["abc", "1.5", "1e999"])("refuses the non-integer startIndex %o", async (raw) => {
      const p = await platform();
      const res = await read(
        p.fetch,
        `?name=output&startIndex=${raw}`,
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(400);
    });

    test("omits startIndex entirely when the caller does not ask", async () => {
      // Not defaulted to 0: their signature makes it optional and their
      // implementation resolves an absent one itself.
      const p = await platform();
      await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(p.world.asked[0]).not.toHaveProperty("startIndex");
    });
  });

  describe("the body", () => {
    test("is the stream's bytes, in order", async () => {
      const p = await platform(fakeWorld(["hello ", "world"]));
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(await res.text()).toBe("hello world");
    });

    test("carries arbitrary bytes, not just text", async () => {
      const p = await platform(fakeWorld([new Uint8Array([0, 255, 128])]));
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0, 255, 128]));
    });

    /**
     * LIVE, not buffered.
     *
     * A handler that collected the stream into an array would pass every assertion
     * above and destroy the feature — so this reads the first chunk while the
     * stream is still open, which a buffered implementation cannot answer.
     */
    test("delivers a chunk before the stream has finished", async () => {
      const p = await platform(fakeWorld(["first"], { live: true }));
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      const reader = res.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toBe("first");
      // Still open: the run has not written its EOF.
      expect(first?.done).toBe(false);
      await reader?.cancel();
    });

    test("says it must not be buffered on the way", async () => {
      // A proxy that batched chunks would make a live read arrive in bursts, which
      // is indistinguishable from a slow agent.
      const p = await platform();
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
    });
  });

  describe("the bound", () => {
    test("is ten minutes, and exists at all", () => {
      // The number matters less than that there IS one: a stream whose run died
      // never sees an EOF, and the alternative is a connection held for the life of
      // the process.
      expect(STREAM_READ_MAX_MS).toBe(600_000);
    });

    test("closes a still-open stream rather than erroring it", async () => {
      // Close, not error: the reader has everything up to here and its next request
      // resumes with `startIndex`. An error would read as a fault.
      vi.useFakeTimers();
      try {
        const p = await platform(fakeWorld(["partial"], { live: true }));
        const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
        const reader = res.body?.getReader();
        await reader?.read();
        await vi.advanceTimersByTimeAsync(STREAM_READ_MAX_MS + 1);
        // Resolves rather than rejecting, and reports the stream as finished.
        await expect(reader?.read()).resolves.toMatchObject({ done: true });
      } finally {
        vi.useRealTimers();
      }
    });

    test("releases its timer when the stream ends on its own", async () => {
      // A `setTimeout` per read that outlives its stream is the leak this bound
      // exists to prevent, so the natural end has to clear it. With fake timers, a
      // pending one would still be counted.
      vi.useFakeTimers();
      try {
        const p = await platform(fakeWorld(["done"]));
        const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
        await res.text();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("releases its timer when the client goes away", async () => {
      vi.useFakeTimers();
      try {
        const p = await platform(fakeWorld(["partial"], { live: true }));
        const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
        const reader = res.body?.getReader();
        await reader?.read();
        await reader?.cancel();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("when there is nothing to read from", () => {
    test("answers 501 with no run storage configured", async () => {
      const harness = await createTestOrchestrator();
      await harness.fetch("/deploy", {
        method: "POST",
        headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: MINE,
          env: { ASSEMBLYAI_API_KEY: "k" },
          worker:
            'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
          clientFiles: {},
        }),
      });
      const res = await read(harness.fetch, "?name=output", await bearerFor(harness.store, MINE));
      expect(res.status).toBe(501);
    });

    test("answers 501 when their streamer has no readFromStream", async () => {
      // Their shape moved. Not a 500: this deployment cannot serve it, and no retry
      // changes that.
      const world = fakeWorld();
      world.streamer = {};
      const p = await platform(world);
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(res.status).toBe(501);
    });

    test("answers 503 when opening the stream fails", async () => {
      const world = fakeWorld();
      world.streamer = {
        readFromStream: () => Promise.reject(new Error("connection refused")),
      };
      const p = await platform(world);
      const res = await read(p.fetch, "?name=output", await bearerFor(p.store, MINE));
      expect(res.status).toBe(503);
    });
  });
});
