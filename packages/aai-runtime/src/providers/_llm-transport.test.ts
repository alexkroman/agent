// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createLlmFetch, isPlainRequest, isStaleConnection } from "./_llm-transport.ts";
import type { FetchLike } from "./_request-body-extras.ts";

/** undici's shape for a connection closed under a request: `TypeError("fetch failed", { cause })`. */
function socketFailure(code: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code }),
  });
}

function recorder(answer: (call: number) => Promise<Response>) {
  const calls: Parameters<FetchLike>[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push([input, init]);
    return answer(calls.length);
  };
  return { calls, fetch };
}

const ok = () => Promise.resolve(new Response("ok"));
const POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

describe("createLlmFetch", () => {
  test("a plain request rides the keep-alive transport while the global is Node's own", async () => {
    const native = recorder(ok);
    const keepAlive = recorder(ok);
    const llmFetch = createLlmFetch({
      ambient: () => native.fetch,
      native: native.fetch,
      keepAlive: () => keepAlive.fetch,
    });
    await llmFetch("https://llm.example/v1/chat/completions", POST);
    expect(keepAlive.calls).toHaveLength(1);
    expect(native.calls).toHaveLength(0);
  });

  test("a replaced global (eval network, vi.stubGlobal) gets the request, read per call", async () => {
    const native = recorder(ok);
    const keepAlive = recorder(ok);
    const stub = recorder(ok);
    let ambient: FetchLike = native.fetch;
    const llmFetch = createLlmFetch({
      ambient: () => ambient,
      native: native.fetch,
      keepAlive: () => keepAlive.fetch,
    });
    ambient = stub.fetch;
    await llmFetch("https://llm.example/", POST);
    expect(stub.calls).toHaveLength(1);
    expect(keepAlive.calls).toHaveLength(0);
  });

  test("a request undici would stringify stays on Node's fetch", async () => {
    const native = recorder(ok);
    const keepAlive = recorder(ok);
    const llmFetch = createLlmFetch({
      ambient: () => native.fetch,
      native: native.fetch,
      keepAlive: () => keepAlive.fetch,
    });
    await llmFetch("https://llm.example/", { ...POST, headers: new Headers({ a: "b" }) });
    expect(native.calls).toHaveLength(1);
    expect(keepAlive.calls).toHaveLength(0);
  });

  test("a connection closed as it was reused is re-sent once, immediately", async () => {
    const native = recorder(ok);
    const keepAlive = recorder((call) =>
      call === 1 ? Promise.reject(socketFailure("UND_ERR_SOCKET")) : ok(),
    );
    const llmFetch = createLlmFetch({
      ambient: () => native.fetch,
      native: native.fetch,
      keepAlive: () => keepAlive.fetch,
    });
    const response = await llmFetch("https://llm.example/", POST);
    expect(await response.text()).toBe("ok");
    expect(keepAlive.calls).toHaveLength(2);
  });

  test("never re-sent twice, after an abort, or for anything but a dead connection", async () => {
    const native = recorder(ok);
    const dead = recorder(() => Promise.reject(socketFailure("ECONNRESET")));
    const build = (keepAlive: FetchLike) =>
      createLlmFetch({
        ambient: () => native.fetch,
        native: native.fetch,
        keepAlive: () => keepAlive,
      });

    await expect(build(dead.fetch)("https://llm.example/", POST)).rejects.toThrow("fetch failed");
    expect(dead.calls).toHaveLength(2);

    const aborted = recorder(() => Promise.reject(socketFailure("ECONNRESET")));
    const controller = new AbortController();
    controller.abort();
    await expect(
      build(aborted.fetch)("https://llm.example/", { ...POST, signal: controller.signal }),
    ).rejects.toThrow("fetch failed");
    expect(aborted.calls).toHaveLength(1);

    const refused = recorder(() => Promise.reject(socketFailure("ECONNREFUSED")));
    await expect(build(refused.fetch)("https://llm.example/", POST)).rejects.toThrow();
    expect(refused.calls).toHaveLength(1);
  });
});

describe("isStaleConnection / isPlainRequest", () => {
  test.each([
    [socketFailure("UND_ERR_SOCKET"), true],
    [socketFailure("EPIPE"), true],
    [socketFailure("ENOTFOUND"), false],
    [new TypeError("fetch failed"), false],
    ["fetch failed", false],
  ])("isStaleConnection(%s) is %s", (error, expected) => {
    expect(isStaleConnection(error)).toBe(expected);
  });

  test("what the AI SDK sends is plain; global classes undici would stringify are not", () => {
    expect(isPlainRequest("https://x/", POST)).toBe(true);
    expect(isPlainRequest(new URL("https://x/"), { body: new Uint8Array(1) })).toBe(true);
    expect(isPlainRequest("https://x/")).toBe(true);
    expect(isPlainRequest(new Request("https://x/"))).toBe(false);
    expect(isPlainRequest("https://x/", { body: new Blob(["x"]) })).toBe(false);
    expect(isPlainRequest("https://x/", { body: new FormData() })).toBe(false);
  });
});
