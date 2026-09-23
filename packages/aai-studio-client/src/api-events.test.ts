// Copyright 2026 the AAI authors. MIT license.
// The studio's SSE subscription policy: the bearer goes in a header, a
// rejected bearer is reported as `auth` (reconnecting with it can only loop),
// everything else is `transport`, and the caller's own abort reports nothing.

import type { EventStreamFrame } from "@alexkroman1/aai/workflow-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchCall, jsonResponse, settle, sseResponse, stubFetch } from "./_test-utils.ts";
import { type StreamDownReason, watchEventStream } from "./api-events.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function recorder() {
  const frames: EventStreamFrame[] = [];
  const downs: StreamDownReason[] = [];
  const onOpen = vi.fn();
  return {
    frames,
    downs,
    onOpen,
    handlers: {
      onFrame: (f: EventStreamFrame) => frames.push(f),
      onOpen,
      onDown: (r: StreamDownReason) => downs.push(r),
    },
  };
}

/** Let the subscription's async body run to its `finally`. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await settle();
}

describe("watchEventStream", () => {
  test("sends the bearer as a header and asks for an event stream", async () => {
    const mock = stubFetch(() => sseResponse([]));
    const rec = recorder();
    watchEventStream("tok-1", "/studio/projects/p/events", rec.handlers);
    await drain();
    const { url, init } = fetchCall(mock);
    expect(url).toBe("/studio/projects/p/events");
    expect(init.headers).toEqual({
      Authorization: "Bearer tok-1",
      Accept: "text/event-stream",
    });
  });

  test("delivers named frames with parsed data, then reports a transport close", async () => {
    stubFetch(() =>
      sseResponse([
        'event: project\ndata: {"name":"p"}\n\n',
        "event: ping\ndata: \n\n",
        'data: {"unnamed":true}\n\n',
      ]),
    );
    const rec = recorder();
    watchEventStream("k", "/e", rec.handlers);
    await drain();
    expect(rec.onOpen).toHaveBeenCalledTimes(1);
    expect(rec.frames).toEqual([
      { event: "project", data: { name: "p" } },
      { event: "ping", data: undefined },
    ]);
    // The server ended a stream it had accepted: reconnecting fixes that.
    expect(rec.downs).toEqual(["transport"]);
  });

  test("reassembles a frame split across chunks", async () => {
    stubFetch(() => sseResponse(["event: pro", 'ject\ndata: {"n":', "1}\n\n"]));
    const rec = recorder();
    watchEventStream("k", "/e", rec.handlers);
    await drain();
    expect(rec.frames).toEqual([{ event: "project", data: { n: 1 } }]);
  });

  test.each([401, 403])("a %i is an AUTH failure and never opens", async (status) => {
    stubFetch(() => jsonResponse({ error: "no" }, status));
    const rec = recorder();
    watchEventStream("dead", "/e", rec.handlers);
    await drain();
    expect(rec.onOpen).not.toHaveBeenCalled();
    expect(rec.downs).toEqual(["auth"]);
  });

  test.each([404, 500, 503])("a %i is a TRANSPORT failure", async (status) => {
    stubFetch(() => jsonResponse({ error: "no" }, status));
    const rec = recorder();
    watchEventStream("k", "/e", rec.handlers);
    await drain();
    expect(rec.onOpen).not.toHaveBeenCalled();
    expect(rec.downs).toEqual(["transport"]);
  });

  test("a rejected fetch is a TRANSPORT failure", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const rec = recorder();
    watchEventStream("k", "/e", rec.handlers);
    await drain();
    expect(rec.downs).toEqual(["transport"]);
  });

  test("a 200 with no body is a TRANSPORT failure and never opens", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const rec = recorder();
    watchEventStream("k", "/e", rec.handlers);
    await drain();
    expect(rec.onOpen).not.toHaveBeenCalled();
    expect(rec.downs).toEqual(["transport"]);
  });

  test("the caller's own abort reports nothing, and aborts the request", async () => {
    // A stream the test ends by hand, so the subscription really reaches its
    // `finally` AFTER the abort — the case that must not call `onDown`.
    let end: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => controller.close();
      },
    });
    const mock = stubFetch(
      () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );
    const rec = recorder();
    const stop = watchEventStream("k", "/e", rec.handlers);
    await drain();
    expect(rec.onOpen).toHaveBeenCalledTimes(1);
    stop();
    end();
    await drain();
    expect(fetchCall(mock).init.signal?.aborted).toBe(true);
    expect(rec.downs).toEqual([]);
  });

  test("the same stream ending WITHOUT an abort does report", async () => {
    let end: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => controller.close();
      },
    });
    stubFetch(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const rec = recorder();
    watchEventStream("k", "/e", rec.handlers);
    await drain();
    end();
    await drain();
    expect(rec.downs).toEqual(["transport"]);
  });
});
