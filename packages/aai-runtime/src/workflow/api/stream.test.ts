// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /workflows/runs/:id/stream`: a run's written chunks as SSE, bounded by the
 * tail read before the stream opens, with `missing` for an unknown run.
 *
 * Moved out of `workflow/api.test.ts`. Driven through a REAL `node:http` server via
 * the shared harness, like its parent: the cases are about what reaches the wire.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chunkStream, fakeClient, type Harness, run, serve } from "./_test-utils.ts";

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
});

describe("GET /runs/:id/stream", () => {
  test("streams the run's written chunks, then done", async () => {
    const stream = vi.fn(async () => chunkStream([{ step: 1 }, { step: 2 }]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toBe(
      'event: chunk\ndata: {"step":1}\n\n' +
        'event: chunk\ndata: {"step":2}\n\n' +
        'event: done\ndata: {"runId":"wrun_1","complete":false}\n\n',
    );
  });

  test("ends at the TAIL rather than waiting for a close that never comes", async () => {
    // The bug this route exists in its current shape to avoid: a workflow stream
    // reports `done` only when CLOSED, and a progress channel written by
    // successive steps is never closed — so a reader that waits for the end waits
    // forever, on a finished run too. The tail is the bound instead. The fake
    // stream here never ends, which is exactly what the real one does.
    const endless = new ReadableStream<unknown>({
      pull(controller) {
        controller.enqueue("line");
      },
    });
    harness = await serve({
      engine: () => fakeClient({ stream: async () => endless, streamTail: async () => 2 }),
    });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    const body = await res.text();
    // Exactly tail + 1 chunks, then the terminator.
    expect(body.match(/event: chunk/g)).toHaveLength(3);
    expect(body).toContain("event: done");
  });

  test("a stream nothing has written answers a bare done", async () => {
    harness = await serve({
      engine: () => fakeClient({ stream: async () => chunkStream([]), streamTail: async () => -1 }),
    });
    const body = await (await fetch(`${harness.url}/workflows/runs/wrun_1/stream`)).text();
    expect(body).not.toContain("event: chunk");
    expect(body).toContain("event: done");
  });

  test("a budget of zero opens NO stream", async () => {
    // The poll a caught-up page makes once a second: `startIndex` is the first
    // index the reader has NOT seen (an INCLUSIVE floor), so a reader that has
    // consumed chunks 0-2 sends 3 against a tail of 2 and the budget is zero —
    // for as long as the step writes nothing. Opening a world read to take no
    // chunks from it is the read that leaked a listener pair per request — see
    // `workflow-stream-readers.test.ts`.
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream, streamTail: async () => 2 }) });
    const body = await (
      await fetch(`${harness.url}/workflows/runs/wrun_1/stream?startIndex=3`)
    ).text();
    expect(stream).not.toHaveBeenCalled();
    expect(body).not.toContain("event: chunk");
    expect(body).toContain("event: done");
  });

  test("`complete` reports the RUN's state, which is what stops a reader", async () => {
    harness = await serve({
      engine: () =>
        fakeClient({
          get: async () => run({ status: "completed", output: 1 }),
          stream: async () => chunkStream(["only"]),
          streamTail: async () => 0,
        }),
    });
    const body = await (await fetch(`${harness.url}/workflows/runs/wrun_1/stream`)).text();
    expect(body).toContain('"complete":true');
  });

  /**
   * An unknown run is a `missing` FRAME on a 200, not a 404.
   *
   * The FAILING observation: `/events` and `/stream` are two questions about one
   * run and answered the same question two ways — 200 with a `missing` frame,
   * and 404. Four things say the 404 is the wrong one. `workflow/api.ts`'s route
   * table already advertises `GET /runs/:id/stream → SSE: chunk | done |
   * missing`, and the code emitted no `missing` ever. Both SDK readers already
   * handle one — `outputOnce` in `sdk/workflow-api-follow.ts` and
   * `consumeFrames` in `aai-ui/use-workflow-progress.ts`, the latter having
   * classified the 404 as "this agent does not serve this route" and hidden the
   * progress UI for what is really an unknown id. An SSE endpoint cannot 404 a
   * run that vanishes MID-stream, so a status-coded answer makes "the run is
   * gone" depend on when you asked. And 404 on this route already means
   * something else — `WORKFLOWS_UNAVAILABLE_MESSAGE`, an agent with no workflow
   * API — which is the ambiguity `WorkflowApi.get`'s doc records as having no
   * second signal to read. Now it has one.
   *
   * The read-FIRST stays, and it was never about the status: `ctx.workflows.stream`
   * is lazy, so an id that reaches it opens a 200 and fails on the first pull,
   * which a page cannot tell from a dropped connection.
   */
  test("an unknown run is a 200 carrying `missing`, not a 404", async () => {
    const stream = vi.fn();
    harness = await serve({ engine: () => fakeClient({ get: async () => undefined, stream }) });
    const res = await fetch(`${harness.url}/workflows/runs/gone/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe('event: missing\ndata: {"runId":"gone"}\n\n');
    // Still never opened: the frame is what the read-first buys, not a status.
    expect(stream).not.toHaveBeenCalled();
  });

  test("forwards namespace and startIndex, negative index included", async () => {
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    await fetch(`${harness.url}/workflows/runs/wrun_1/stream?namespace=logs&startIndex=-3`);
    expect(stream).toHaveBeenCalledWith("wrun_1", { namespace: "logs", startIndex: -3 });
  });

  test("passes no options when the query carried none", async () => {
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(stream).toHaveBeenCalledWith("wrun_1", {});
  });

  test.each(["half", "", "%20%20"])("a startIndex of %j is a 400", async (value) => {
    // The FAILING observation is the EMPTY one. `Number("")` is `0`, not `NaN`,
    // so `?startIndex=` passed the integer check as a legitimate `0` — and
    // `startIndex` is an INCLUSIVE floor, so `0` is the whole stream. A caller
    // that meant to send a cursor and sent nothing was answered with a full
    // replay of every chunk it had already read, once per poll. An empty
    // parameter is a malformed request, not a default, which is the same call
    // `?limit=` already gets one route over.
    const stream = vi.fn(async () => chunkStream([]));
    harness = await serve({ engine: () => fakeClient({ stream }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream?startIndex=${value}`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "`startIndex` must be an integer" });
    expect(stream).not.toHaveBeenCalled();
  });

  test("is matched before the bare `/runs/:id` GET", async () => {
    // Same ordering hazard as `/events`: listed after the prefix rule, the whole
    // `wrun_1/stream` would be read as a run id and answer 404 for a live run.
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // `get` still runs — the route reads the run first to answer 404 honestly —
    // but with the id parsed clean of the suffix.
    expect(get).toHaveBeenCalledWith("wrun_1");
  });

  test("concurrent polls of ONE run share that read rather than each taking one", async () => {
    // The read-first above is one `POST /:slug/workflow-journal` on a deployed
    // agent, and it is the read a watched run attracts most of: a page polls
    // this route once a second for the life of the run. Un-shared, four tabs
    // were four of them a second competing with that run's own journal WRITES
    // for one of the four connections a replica's admin pool allows — measured
    // here as four reads for four requests, two now (see `readRunOnce` for why
    // the floor is two rather than one).
    //
    // The client is built ONCE and returned by the getter, which is what a real
    // deployment does — the shared reads are keyed on the reader's identity, so
    // a harness minting a fresh one per request would measure nothing.
    //
    // The read is HELD until all four requests have arrived, which is the only
    // way they overlap: against a fake resolving in a microtask, four loopback
    // requests are served strictly one after another and there is no concurrency
    // to collapse. That is not an artifact of the harness — it is what makes the
    // deployed case the interesting one, where the read is a network POST and
    // overlap is the norm.
    const arrived = Promise.withResolvers<void>();
    let requests = 0;
    const get = vi.fn(async () => {
      await arrived.promise;
      return run();
    });
    const client = fakeClient({ get, streamTail: async () => -1 });
    harness = await serve({
      engine: () => client,
      onRequest: () => {
        requests += 1;
        if (requests === 4) arrived.resolve();
      },
    });
    const url = `${harness.url}/workflows/runs/wrun_1/stream`;
    const answers = await Promise.all([fetch(url), fetch(url), fetch(url), fetch(url)]);
    expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(get.mock.calls.length).toBe(2);
  });
});
