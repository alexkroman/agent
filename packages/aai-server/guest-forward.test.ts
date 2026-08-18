// Copyright 2026 the AAI authors. MIT license.
/**
 * `forwardToGuest`'s three deadline bounds.
 *
 * The header filters are asserted where they matter — `workflow-handler.test.ts`
 * and `workflow-webhook-handler.test.ts` drive them through a real
 * orchestrator. What can only be seen here is the DEADLINE, because a bound is
 * a claim about time and an orchestrator test cannot pace a request body.
 *
 * The pair that carries the file is `progresses under "activity"` against
 * `progresses under "headers"`: the SAME script, differing only in the bound,
 * one resolving and one aborting. That is the shipped bug — `POST
 * /workflows/uploads` answers 201 only once the last byte is stored, so a
 * head-only deadline bounded the whole transfer and a 500 MB recording needed
 * ~133 Mbps to beat 30s.
 *
 * Virtual time throughout: a spec that waits out real milliseconds to see
 * whether a window elapsed is a race, and the flake then names the timing spec
 * rather than the bug.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { forwardToGuest } from "./guest-forward.ts";

const TIMEOUT_MS = 1000;

/** A request body the test feeds by hand, recording whether it was cancelled. */
function pushableBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    /** One chunk, ignored once the stream is gone — an abort races the script. */
    push(): void {
      try {
        controller?.enqueue(new Uint8Array([1]));
      } catch {
        // Already cancelled by the deadline; the assertion is on the forward.
      }
    },
    close(): void {
      try {
        controller?.close();
      } catch {
        // Same.
      }
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * A guest that drains the request body and then answers.
 *
 * It has to honour `signal` the way undici does — REJECTING with the abort
 * reason — because "the deadline fired" and "the guest answered" are the two
 * outcomes every test here distinguishes. Cancelling the reader is what makes
 * the pending `read()` settle; the flag is what turns that into a throw rather
 * than a clean end.
 */
function drainingGuest(answer: () => Response = () => new Response("{}", { status: 200 })) {
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    const signal = init?.signal ?? null;
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      let abortReason: unknown;
      const onAbort = (): void => {
        abortReason = signal?.reason ?? new Error("aborted");
        void reader.cancel(abortReason);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      for (;;) {
        const { done } = await reader.read();
        if (abortReason !== undefined) throw abortReason;
        if (done) break;
      }
    }
    return answer();
  };
  return fetchFn;
}

/** A guest that never answers at all, so only the deadline can settle the call. */
const silentGuest: typeof globalThis.fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Settle a forward into an outcome object, attaching the handler NOW.
 *
 * Every test here rejects its forward from inside
 * `vi.advanceTimersByTimeAsync`, which runs real macrotask ticks — so a handler
 * attached afterwards (`await expect(forward).rejects`) is attached too late and
 * Node reports the rejection as unhandled, failing the file while every
 * assertion passes. Capturing before the clock moves is the fix, and it is the
 * reason this is a helper rather than a `try`/`catch` per test.
 */
function capture<T>(promise: Promise<T>): Promise<{ res?: T; err?: unknown }> {
  return promise.then(
    (res) => ({ res }),
    (err: unknown) => ({ err }),
  );
}

/**
 * Advance to just under the deadline, deliver a chunk, then advance again — a
 * transfer that is slow but never stalls, and whose total exceeds the deadline.
 */
async function paced(bound: "headers" | "activity", body: ReturnType<typeof pushableBody>) {
  const forward = forwardToGuest({
    fetchFn: drainingGuest(),
    url: "https://tunnel.test/workflows/uploads",
    method: "POST",
    body: body.stream,
    timeoutMs: TIMEOUT_MS,
    bound,
  });
  const settled = capture(forward);
  await vi.advanceTimersByTimeAsync(800);
  body.push();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(400);
  body.close();
  await vi.advanceTimersByTimeAsync(0);
  return await settled;
}

describe('bound: "activity"', () => {
  test("a slow but progressing request body outlives the deadline", async () => {
    // 1200ms of transfer against a 1000ms deadline: every chunk drained re-arms
    // it, so the only thing that can fail is a STALL.
    const body = pushableBody();
    const outcome = await paced("activity", body);
    expect(outcome).toMatchObject({ res: { status: 200 } });
    expect(body.cancelled).toBe(false);
  });

  test("the same script under the old bound aborts mid-transfer", async () => {
    // The regression twin. Progress buys nothing when the deadline is a total,
    // which is what made a 500 MB upload a 503 at 30.3s on the platform and
    // fine under `aai dev`, where there is no forward and no deadline.
    const body = pushableBody();
    const outcome = await paced("headers", body);
    expect(outcome).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
    // And the inbound body is released rather than left for nobody to drain.
    expect(body.cancelled).toBe(true);
  });

  test("a STALLED request body still aborts on time", async () => {
    const body = pushableBody();
    const forward = forwardToGuest({
      fetchFn: drainingGuest(),
      url: "https://tunnel.test/workflows/uploads",
      method: "POST",
      body: body.stream,
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    const settled = capture(forward);
    await vi.advanceTimersByTimeAsync(800);
    body.push();
    await vi.advanceTimersByTimeAsync(0);
    // Nothing more arrives: one full budget with no progress is the failure this
    // bound still has to report, or it is not a deadline at all.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
  });

  test("it disarms on the response head, so an endless body is left alone", async () => {
    const endless = new ReadableStream<Uint8Array>({ start: () => undefined });
    const res = await forwardToGuest({
      fetchFn: () => Promise.resolve(new Response(endless, { status: 200 })),
      url: "https://tunnel.test/workflows/runs/wrun_1/events",
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    expect(res.status).toBe(200);
    // No timer survives the call, so nothing can abort the stream later — the
    // truncated chunked response `live-streams.ts` exists to prevent.
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a buffered body needs no branch at the call site", async () => {
    // `"activity"` degrades to `"headers"` when there is nothing to measure,
    // which is why the workflow route passes it for every method.
    const res = await forwardToGuest({
      fetchFn: drainingGuest(),
      url: "https://tunnel.test/workflows/runs",
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    expect(res.status).toBe(200);
  });
});

describe("the other two bounds are unchanged", () => {
  test('"response" (the default) still takes the un-rearmable signal', async () => {
    // Asserted STRUCTURALLY rather than by waiting the deadline out, because
    // `AbortSignal.timeout` is one of the waits `vi.useFakeTimers()` does not
    // patch: driving that branch really costs `timeoutMs` of wall clock, which
    // is the flake-first shape this repo keeps out of the unit tier.
    //
    // What it pins is the one regression the bound normalization can cause. The
    // branch is `bound === "response" ? undefined : new AbortController()`, so
    // an omitted `bound` resolving to the wrong side would silently give the two
    // buffering callers (`/client-config`, the webhook) a deadline that the
    // request body could re-arm — and no test of theirs could see it.
    const armed: number[] = [];
    const counting: typeof globalThis.fetch = () => {
      armed.push(vi.getTimerCount());
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const url = "https://tunnel.test/client-config";
    await forwardToGuest({ fetchFn: counting, url, timeoutMs: TIMEOUT_MS });
    await forwardToGuest({ fetchFn: counting, url, timeoutMs: TIMEOUT_MS, bound: "response" });
    await forwardToGuest({ fetchFn: counting, url, timeoutMs: TIMEOUT_MS, bound: "headers" });
    // Omitted and explicit `"response"` agree, and only the hand-held bound
    // arms a timer of ours.
    expect(armed).toEqual([0, 0, 1]);
  });

  test('"headers" bounds a guest that never answers', async () => {
    const forward = forwardToGuest({
      fetchFn: silentGuest,
      url: "https://tunnel.test/workflows",
      timeoutMs: TIMEOUT_MS,
      bound: "headers",
    });
    const settled = capture(forward);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
  });
});
