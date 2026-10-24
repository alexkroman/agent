// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createLlmFetch, isNodeFetch, isPlainRequest } from "./_llm-transport.ts";
import type { FetchLike } from "./_request-body-extras.ts";

function recorder() {
  const calls: Parameters<FetchLike>[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push([input, init]);
    return Promise.resolve(new Response("ok"));
  };
  return { calls, fetch };
}

const POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

/** A transport over `ambient`, which counts as Node's own when `native` says so. */
function transport(ambient: FetchLike, native: boolean) {
  const keepAlive = recorder();
  const llmFetch = createLlmFetch({
    ambient: () => ambient,
    isNative: () => native,
    keepAlive: () => keepAlive.fetch,
  });
  return { llmFetch, keepAlive };
}

describe("createLlmFetch", () => {
  test("a plain request rides the keep-alive transport while the global is Node's own", async () => {
    const global = recorder();
    const { llmFetch, keepAlive } = transport(global.fetch, true);
    await llmFetch("https://llm.example/v1/chat/completions", POST);
    expect(keepAlive.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(0);
  });

  test("a replaced global (eval network, an interceptor, vi.stubGlobal) gets the request", async () => {
    const stub = recorder();
    const { llmFetch, keepAlive } = transport(stub.fetch, false);
    await llmFetch("https://llm.example/", POST);
    expect(stub.calls).toHaveLength(1);
    expect(keepAlive.calls).toHaveLength(0);
  });

  test("a request undici would stringify stays on Node's fetch", async () => {
    const global = recorder();
    const { llmFetch, keepAlive } = transport(global.fetch, true);
    await llmFetch("https://llm.example/", { ...POST, headers: new Headers({ a: "b" }) });
    expect(global.calls).toHaveLength(1);
    expect(keepAlive.calls).toHaveLength(0);
  });
});

describe("isNodeFetch", () => {
  test("recognizes the fetch THIS Node ships — a rename there must fail here, not go quiet", () => {
    expect(isNodeFetch(globalThis.fetch)).toBe(true);
  });

  test("a wrapper or a Proxy around it (how interceptors patch) is not Node's", () => {
    const native = globalThis.fetch;
    expect(isNodeFetch((input, init) => native(input, init))).toBe(false);
    expect(isNodeFetch(new Proxy(native, {}))).toBe(false);
  });
});

describe("isPlainRequest", () => {
  test("what the AI SDK sends is plain; global classes undici would stringify are not", () => {
    expect(isPlainRequest("https://x/", POST)).toBe(true);
    expect(isPlainRequest(new URL("https://x/"), { body: new Uint8Array(1) })).toBe(true);
    expect(isPlainRequest("https://x/")).toBe(true);
    expect(isPlainRequest(new Request("https://x/"))).toBe(false);
    expect(isPlainRequest("https://x/", { body: new Blob(["x"]) })).toBe(false);
    expect(isPlainRequest("https://x/", { body: new FormData() })).toBe(false);
  });
});
