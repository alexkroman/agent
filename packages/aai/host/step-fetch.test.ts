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
const { STEP_FETCH_CONNECTIONS, STEP_FETCH_KEEP_ALIVE_MS, STEP_FETCH_PIPELINING } = await import(
  "../sdk/constants.ts"
);

describe("createStepFetch", () => {
  test("pins HTTP/1.1 — the one option the whole module exists for", () => {
    agentOptions.length = 0;
    createStepFetch();
    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0]).toMatchObject({ allowH2: false });
  });

  test("sizes the pool for a fan-out and disables the timeouts a step owns itself", () => {
    agentOptions.length = 0;
    createStepFetch();
    expect(agentOptions[0]).toMatchObject({
      connections: STEP_FETCH_CONNECTIONS,
      keepAliveTimeout: STEP_FETCH_KEEP_ALIVE_MS,
      // One request per connection: pipelining is the HTTP/1.1 shape of the head
      // -of-line blocking this fetch exists to avoid.
      pipelining: STEP_FETCH_PIPELINING,
      // A step passes its own `AbortSignal`; undici's 300s defaults would cut a
      // long provider call off with a transport error nothing can classify.
      headersTimeout: 0,
      bodyTimeout: 0,
    });
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
