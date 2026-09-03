// Copyright 2026 the AAI authors. MIT license.
/**
 * `allowH2: false` IS the mechanism, so it gets a test that fails when it moves.
 *
 * Every other property of this module is observable — a request goes out, a
 * response comes back — and this one is not: dropping the flag leaves a fetch
 * that works perfectly, over HTTP/2, and a fan-out that collects stream resets
 * under concurrency against a live provider and nowhere else. That is the same
 * silent-success shape the repo's gates are built to refuse, so the Agent's
 * options are asserted directly.
 */

import { describe, expect, test, vi } from "vitest";

const agentOptions: unknown[] = [];
const requests: { url: string; init: Record<string, unknown> }[] = [];

vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) {
      agentOptions.push(options);
    }
  },
  fetch: vi.fn(async (url: string, init: Record<string, unknown>) => {
    requests.push({ url, init });
    return new Response("ok");
  }),
}));

const { createStepFetch } = await import("./step-fetch.ts");
const {
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_INACTIVITY_MS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} = await import("@alexkroman1/aai/host-internal");
const { TRANSCRIBE_SYNC_TIMEOUT_MS } = await import("@alexkroman1/aai/step");
const { withRunContext } = await import("./workflow-run-context.ts");

describe("createStepFetch", () => {
  test("pins HTTP/1.1 — the one option the whole module exists for", () => {
    agentOptions.length = 0;
    createStepFetch();
    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0]).toMatchObject({ allowH2: false });
  });

  test("sizes the pool for a fan-out and bounds a request that stops progressing", () => {
    agentOptions.length = 0;
    createStepFetch();
    expect(agentOptions[0]).toMatchObject({
      connections: STEP_FETCH_CONNECTIONS,
      keepAliveTimeout: STEP_FETCH_KEEP_ALIVE_MS,
      // One request per connection: pipelining is the HTTP/1.1 shape of the head
      // -of-line blocking this fetch exists to avoid.
      pipelining: STEP_FETCH_PIPELINING,
      // Both were `0` — OFF — justified by a step owning its own deadline
      // "or the DevKit's step budget". There is no step budget any more, and the
      // engine hands a step body no signal, so a user-written `stepFetch` with no
      // signal of its own was bounded by NOTHING and hung until the process died.
      // These are inactivity/phase timers rather than total-duration ones, which
      // is what lets one number cover a 4 KB JSON call and a 660 MiB upload alike
      // — see the constant.
      headersTimeout: STEP_FETCH_INACTIVITY_MS,
      bodyTimeout: STEP_FETCH_INACTIVITY_MS,
    });
  });

  test("that bound is NOT zero, which is the whole regression", () => {
    // Asserted separately and against the literal, because the test above would
    // pass just as happily if the constant itself went back to `0` — and `0` is
    // the value that means "no layer bounds this request at all".
    agentOptions.length = 0;
    createStepFetch();
    const options = agentOptions[0] as { headersTimeout: number; bodyTimeout: number };
    expect(options.headersTimeout).toBeGreaterThan(0);
    expect(options.bodyTimeout).toBeGreaterThan(0);
    // And it has to clear the longest server think-time this SDK can produce —
    // the sync transcription endpoint's own 120s contract — or restoring the
    // bound would truncate exactly the calls turning it off was meant to protect.
    expect(options.headersTimeout).toBeGreaterThan(TRANSCRIBE_SYNC_TIMEOUT_MS);
  });

  test("builds ONE dispatcher per server, so a fan-out's batches share a warm pool", async () => {
    agentOptions.length = 0;
    const fetchFn = createStepFetch().fetch;
    await fetchFn("https://example.test/a");
    await fetchFn("https://example.test/b");
    expect(agentOptions).toHaveLength(1);
  });

  test("attaches that dispatcher to every request", async () => {
    requests.length = 0;
    const fetchFn = createStepFetch().fetch;
    await fetchFn("https://example.test/x");
    expect(requests[0]?.init.dispatcher).toBeDefined();
  });

  test("passes only the plain shapes that survive the realm boundary", async () => {
    requests.length = 0;
    const signal = new AbortController().signal;
    const body = new Uint8Array([1, 2, 3]);
    await createStepFetch().fetch("https://example.test/x", {
      method: "POST",
      headers: { Authorization: "k" },
      body,
      signal,
    });
    const init = requests[0]?.init ?? {};
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(init.signal).toBe(signal);
    // A plain record, never a `Headers` — undici 8 brand-checks against its own
    // classes, and a foreign one is silently stringified.
    expect(init.headers).toEqual({ Authorization: "k" });
    expect(init.headers).not.toBeInstanceOf(Headers);
  });

  test("COPIES the caller's headers, so the request cannot mutate them", async () => {
    requests.length = 0;
    const headers = { Authorization: "k" };
    await createStepFetch().fetch("https://example.test/x", { headers });
    expect(requests[0]?.init.headers).not.toBe(headers);
  });

  test("omits an absent field rather than sending it as undefined", async () => {
    requests.length = 0;
    await createStepFetch().fetch("https://example.test/x");
    // `exactOptionalPropertyTypes` is about the type; this is about the wire —
    // `{ method: undefined }` is not the same request as one with no method.
    expect(Object.keys(requests[0]?.init ?? {})).toEqual(["dispatcher"]);
  });
});

describe("the WALK's signal reaches a step's outbound request", () => {
  /** The run context a step body is executing inside, with `signal` on the step. */
  function inStep<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    return withRunContext(
      {
        runId: "wrun_1",
        workflow: "flow",
        step: { name: "upload", key: "upload#0", attempt: 1, maxAttempts: 3, signal },
        write: () => Promise.resolve(0),
      },
      fn,
    );
  }

  test("a caller that passes NO signal still gets the walk's", async () => {
    // The regression. The engine hands a step body no `AbortSignal`, so a
    // user-written `stepFetch` had nothing to pass — and a cancelled run went on
    // uploading a recording nobody was waiting for until the process died.
    requests.length = 0;
    const walk = new AbortController();
    const fetchFn = createStepFetch().fetch;

    await inStep(walk.signal, () => fetchFn("https://example.test/x"));
    const sent = requests[0]?.init.signal as AbortSignal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent.aborted).toBe(false);
    walk.abort();
    expect(sent.aborted).toBe(true);
  });

  test("a caller's own signal is COMBINED, not replaced — either side aborts", async () => {
    requests.length = 0;
    const fetchFn = createStepFetch().fetch;
    const byCaller = { walk: new AbortController(), caller: new AbortController() };
    const byWalk = { walk: new AbortController(), caller: new AbortController() };

    for (const pair of [byCaller, byWalk]) {
      await inStep(pair.walk.signal, () =>
        fetchFn("https://example.test/x", { signal: pair.caller.signal }),
      );
    }
    const [first, second] = requests.map((one) => one.init.signal as AbortSignal);

    // The caller's deadline still fires — `stepTranscribeUpload`'s 30 minutes is
    // the shipped instance, and it has to keep winning over a walk nobody
    // cancelled.
    byCaller.caller.abort();
    expect(first?.aborted).toBe(true);
    // And the walk's cancel reaches a request that DID pass a signal, which is
    // what "combined" means and what a `signal: init.signal` passthrough loses.
    byWalk.walk.abort();
    expect(second?.aborted).toBe(true);
  });

  test("outside a run the caller's signal passes through UNTOUCHED", async () => {
    // A step is also an ordinary exported async function every template's specs
    // call directly, so there is no walk to combine with and wrapping the signal
    // would break `expect(init.signal).toBe(signal)` for every one of them.
    requests.length = 0;
    const signal = new AbortController().signal;
    await createStepFetch().fetch("https://example.test/x", { signal });
    expect(requests[0]?.init.signal).toBe(signal);
  });

  test("a run whose walk has no signal adds none", async () => {
    requests.length = 0;
    const fetchFn = createStepFetch().fetch;
    await withRunContext(
      {
        runId: "wrun_1",
        workflow: "flow",
        step: { name: "upload", key: "upload#0", attempt: 1, maxAttempts: 3 },
        write: () => Promise.resolve(0),
      },
      () => fetchFn("https://example.test/x"),
    );
    expect(Object.keys(requests[0]?.init ?? {})).toEqual(["dispatcher"]);
  });
});
