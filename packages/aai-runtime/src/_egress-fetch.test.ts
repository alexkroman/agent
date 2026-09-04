// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's own egress must NOT be `globalThis.fetch`, and nothing observable
 * says so.
 *
 * That is the whole reason this file exists, and it is the same argument
 * `step-fetch.test.ts` makes one layer over: dropping the pool leaves a `fetch`
 * that works perfectly, over HTTP/2, and fails only as a fan-out against a live
 * platform under concurrency. It shipped that way — the upload broker's byte
 * operations, the operator-bucket ones beside them, and every platform RPC were on
 * the global while the flag that fixes exactly this sat one module away — so the
 * DEFAULT each of those three picks is asserted directly, not just the pool's
 * options.
 */

import { describe, expect, test, vi } from "vitest";

const agentOptions: unknown[] = [];
/** One entry per pool `close()` — a drain is DRAINED, never destroyed. */
const closes: number[] = [];
const requests: { url: unknown; init: Record<string, unknown> }[] = [];

vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) {
      agentOptions.push(options);
    }
    async close(): Promise<void> {
      closes.push(agentOptions.length);
    }
  },
  fetch: vi.fn(async (url: unknown, init: Record<string, unknown>) => {
    requests.push({ url, init });
    return new Response("ok", { headers: { "content-length": "2" } });
  }),
}));

const { blobFetch, closeEgressFetch, EGRESS_RPC_HTTP2_ENV, egressRpcAllowsH2, rpcFetch } =
  await import("./_egress-fetch.ts");
const { createBrokeredUploadBlobs } = await import("./_upload-blobs-brokered.ts");
const { createHttpUploadBackend } = await import("./_upload-blobs-http.ts");
const { platformPost } = await import("./platform-rpc.ts");

/** Forget any pool a previous test built, so `agentOptions` counts this test's. */
async function fresh(): Promise<void> {
  await closeEgressFetch();
  agentOptions.length = 0;
  requests.length = 0;
  closes.length = 0;
}

describe("the RPC pool", () => {
  test("pins HTTP/1.1 by default — the answer the byte path measured", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0]).toMatchObject({ allowH2: false, pipelining: 1 });
  });

  test("LEAVES undici's timeouts alone, unlike the step pool", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    // The step pool RAISES both, its bodies being potentially gigabytes. Here the
    // callers bound the REQUEST and nothing bounds draining the body afterwards,
    // which is exactly what a window `read` does — so undici's body-inactivity
    // timeout is the only limit that path has, and turning it off would remove it.
    expect(agentOptions[0]).not.toHaveProperty("headersTimeout");
    expect(agentOptions[0]).not.toHaveProperty("bodyTimeout");
  });

  test("builds ONE pool for the process, so bursts seconds apart share it", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    await rpcFetch("https://platform.test/b");
    expect(agentOptions).toHaveLength(1);
  });

  test("attaches that pool's dispatcher to every request", async () => {
    await fresh();
    await rpcFetch("https://platform.test/x", { method: "HEAD" });
    expect(requests[0]?.init.dispatcher).toBeDefined();
    expect(requests[0]?.init.method).toBe("HEAD");
  });
});

/**
 * The switch, and the trap it exists to avoid falling into.
 *
 * Turning `allowH2` on with `pipelining: 1` is STRICTLY WORSE than the HTTP/1.1
 * it replaces — undici gates a connection's in-flight streams behind that number
 * (nodejs/undici#4143), so the pool would carry one request at a time where
 * HTTP/1.1 had `EGRESS_CONNECTIONS` of them in parallel, and the resulting
 * slowdown would read as an H2 problem. So the two are asserted TOGETHER: a
 * switch that moved one without the other is the bug.
 */
describe("the RPC pool's HTTP/2 switch", () => {
  test("is off unless the environment says otherwise, in the repo's own grammar", () => {
    expect(egressRpcAllowsH2({})).toBe(false);
    expect(egressRpcAllowsH2({ [EGRESS_RPC_HTTP2_ENV]: "1" })).toBe(true);
    expect(egressRpcAllowsH2({ [EGRESS_RPC_HTTP2_ENV]: "true" })).toBe(true);
    // Anything else is off: a variable set to `0` or to a typo must not enable it.
    expect(egressRpcAllowsH2({ [EGRESS_RPC_HTTP2_ENV]: "0" })).toBe(false);
    expect(egressRpcAllowsH2({ [EGRESS_RPC_HTTP2_ENV]: "yes" })).toBe(false);
  });

  test("raises the stream gate with it, or the switch is a pessimization", async () => {
    vi.stubEnv(EGRESS_RPC_HTTP2_ENV, "1");
    await fresh();
    await rpcFetch("https://platform.test/a");
    expect(agentOptions[0]).toMatchObject({ allowH2: true });
    expect((agentOptions[0] as { pipelining: number }).pipelining).toBeGreaterThan(1);
  });

  test("does not reach the BYTE pool, which has no switch to offer", async () => {
    // H2 there is the configuration measured LOSING 2 of 16 requests, so a switch
    // would only hand an operator the known-bad answer.
    vi.stubEnv(EGRESS_RPC_HTTP2_ENV, "1");
    await fresh();
    await blobFetch("https://bucket.test/c");
    expect(agentOptions[0]).toMatchObject({ allowH2: false, pipelining: 1 });
  });
});

describe("the two pools are two pools", () => {
  test("an RPC and a byte call build one each, so neither takes the other's sockets", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    await blobFetch("https://bucket.test/c");
    expect(agentOptions).toHaveLength(2);
    // Different dispatchers, which is the whole of the isolation claim.
    expect(requests[0]?.init.dispatcher).not.toBe(requests[1]?.init.dispatcher);
  });

  test("a process that only ever RPCs never opens the byte pool", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    expect(agentOptions).toHaveLength(1);
  });

  test("a close RESETS rather than poisons, so a held reference keeps working", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    await closeEgressFetch();
    // The same function object, used again after the pool it had was closed.
    await rpcFetch("https://platform.test/b");
    expect(agentOptions).toHaveLength(2);
    expect(requests).toHaveLength(2);
    // Drained, not destroyed — a request already in flight is somebody's.
    expect(closes).toEqual([1]);
  });

  test("a close drains BOTH, and one that was never built is not a failure", async () => {
    await fresh();
    await rpcFetch("https://platform.test/a");
    await blobFetch("https://bucket.test/c");
    await expect(closeEgressFetch()).resolves.toBeUndefined();
    expect(closes).toHaveLength(2);
  });

  test("closing without ever fetching is a no-op, not a pool", async () => {
    await fresh();
    await expect(closeEgressFetch()).resolves.toBeUndefined();
    expect(agentOptions).toHaveLength(0);
    expect(closes).toEqual([]);
  });
});

/**
 * The three callers, and the assertion that matters: the DEFAULT is the pool.
 *
 * `globalThis.fetch` is spied rather than merely absent from the expectation,
 * because "did not use the pool" and "used the global" are the same observation
 * from the outside and only one of them is the bug.
 */
describe("the runtime's own callers default to it", () => {
  /** Fail the test if anything reaches the global. */
  function forbidGlobalFetch(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("reached globalThis.fetch — see _egress-fetch.ts");
    });
  }

  test("the upload broker's byte operations — the ones that failed in production", async () => {
    await fresh();
    const global = forbidGlobalFetch();
    const blobs = createBrokeredUploadBlobs({ base: "https://platform.test/slug" });
    await blobs.size("prefix/upl_1/0");
    expect(global).not.toHaveBeenCalled();
    expect(agentOptions[0]).toMatchObject({ allowH2: false });
    expect(requests[0]?.init.method).toBe("HEAD");
  });

  test("the operator's own bucket, reached the same way", async () => {
    await fresh();
    const global = forbidGlobalFetch();
    const blobs = createHttpUploadBackend({
      url: "https://ref.supabase.test",
      serviceKey: "k",
      bucket: "b",
    });
    await blobs.size("prefix/upl_1/0");
    expect(global).not.toHaveBeenCalled();
    expect(agentOptions[0]).toMatchObject({ allowH2: false });
  });

  test("every platform RPC, which shared the broker's origin and its reset", async () => {
    await fresh();
    const global = forbidGlobalFetch();
    await platformPost(
      { base: "https://platform.test/slug", token: "t" },
      { route: "/workflow-journal", body: "{}", label: "journal", timeoutMs: 1000 },
    );
    expect(global).not.toHaveBeenCalled();
    expect(agentOptions[0]).toMatchObject({ allowH2: false });
  });

  // A fifth caller used to be asserted here: the DevKit world's run-event STREAM
  // read, the worst case of the set — a long-lived stream sharing one multiplexed
  // connection with a burst of byte probes, which is what the incident report
  // showed failing beside the claim's 500s. It went with that world, and the
  // engine's progress streams are the guest's own rather than an HTTP read, so
  // there is no replacement caller to assert.

  test("an explicit fetch still wins, so a spec can fake one", async () => {
    await fresh();
    const fake = vi.fn(async () => new Response(null, { status: 404 }));
    const blobs = createBrokeredUploadBlobs({ base: "https://platform.test/slug", fetch: fake });
    expect(await blobs.size("prefix/upl_1/0")).toBeUndefined();
    expect(fake).toHaveBeenCalledTimes(1);
    expect(agentOptions).toHaveLength(0);
  });
});
