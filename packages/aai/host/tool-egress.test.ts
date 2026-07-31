// Copyright 2026 the AAI authors. MIT license.
/**
 * Self-hosted enforcement of the tool-fetch policy — the dev/prod parity guard.
 *
 * The bug being pinned: without this, an undeclared host, an oversized body, a
 * slow endpoint, or a request at a private IP all worked through `aai dev` (no
 * sandbox, real `globalThis.fetch`) and only failed once deployed, where the
 * guest has no network device and the host decides. These specs assert that
 * self-hosted mode reaches the *same verdicts* as `sandbox-fetch.ts`, and that
 * the exemptions match what the platform actually restricts.
 *
 * `./ssrf.ts` is stubbed to a recording passthrough: SSRF resolution itself is
 * covered by `net.test.ts` / `ssrf-extended.test.ts`, and a real lookup would
 * make these specs depend on DNS. What matters here is that the guard routes
 * through that path at all, with the allowlist as its redirect predicate.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TOOL_FETCH_MAX_CONCURRENT, TOOL_FETCH_MAX_REQUEST_BODY_BYTES } from "../sdk/constants.ts";
import { createMemoryVector } from "./memory-vector.ts";
import { exemptFromToolEgress, installToolFetchGuard, runInToolEgress } from "./tool-egress.ts";

const { ssrfSafeFetch, pinnedFetch } = vi.hoisted(() => ({
  ssrfSafeFetch: vi.fn(
    async (
      url: string,
      init: RequestInit,
      fetchFn: typeof globalThis.fetch,
      _opts?: { isHostAllowed?: (h: string) => boolean },
    ) => fetchFn(url, init),
  ),
  pinnedFetch: vi.fn(),
}));

vi.mock("./ssrf.ts", () => ({ ssrfSafeFetch, pinnedFetch }));

const realFetch = globalThis.fetch;
let inner: ReturnType<typeof vi.fn>;

beforeEach(() => {
  inner = vi.fn(async () => new Response("ok"));
  const stub = inner as unknown as typeof globalThis.fetch;
  globalThis.fetch = stub;
  // An in-scope tool fetch leaves via `pinnedFetch` and the host's own traffic
  // via `globalThis.fetch`; pointing both at one stub lets each spec assert on
  // `inner` without caring which seam carried the call. The spec that *does*
  // care asserts on the identity of the fetch handed to `ssrfSafeFetch` — see
  // "pairs the SSRF dispatcher with its own undici".
  pinnedFetch.mockImplementation(stub);
  installToolFetchGuard();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe("tool egress guard — allowlist", () => {
  test("passes a fetch through untouched outside any tool scope", async () => {
    // The host's own traffic — LLM streams, STT/TTS sockets, the host-side
    // network builtins — must not be subject to an agent's allowedHosts.
    await globalThis.fetch("https://api.anthropic.com/v1/messages");
    expect(inner).toHaveBeenCalledOnce();
    expect(ssrfSafeFetch).not.toHaveBeenCalled();
  });

  test("allows a declared host inside a tool scope", async () => {
    const resp = await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch("https://api.example.com/v1/thing"),
    );
    expect(await resp.text()).toBe("ok");
  });

  test("matches a declared wildcard", async () => {
    await runInToolEgress(["*.example.com"], () => globalThis.fetch("https://a.b.example.com/x"));
    expect(inner).toHaveBeenCalledOnce();
  });

  test("rejects an undeclared host, naming allowedHosts", async () => {
    await expect(
      runInToolEgress(["api.example.com"], () => globalThis.fetch("https://evil.example.net/x")),
    ).rejects.toThrow(/Host "evil\.example\.net" is not allowed.*allowedHosts/s);
    expect(inner).not.toHaveBeenCalled();
  });

  test("says the failure is local parity, not a local-only restriction", async () => {
    await expect(
      runInToolEgress([], () => globalThis.fetch("https://api.example.com/x")),
    ).rejects.toThrow(/deployed agent/);
  });

  test("rejects every host when the agent declared none", async () => {
    // Empty list is "no egress", exactly as the platform treats it: with no
    // allowedHosts the guest's fetch RPC handler is never even registered.
    await expect(
      runInToolEgress([], () => globalThis.fetch("https://api.example.com/x")),
    ).rejects.toThrow(/not allowed/);
    expect(inner).not.toHaveBeenCalled();
  });

  test("enforces on a Request object, not just a URL string", async () => {
    await expect(
      runInToolEgress(["api.example.com"], () =>
        globalThis.fetch(new Request("https://evil.example.net/x")),
      ),
    ).rejects.toThrow(/not allowed/);
  });

  test("enforces on a URL instance", async () => {
    await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch(new URL("https://api.example.com/x")),
    );
    expect(inner).toHaveBeenCalledOnce();
  });

  test("rejects a non-HTTP scheme", async () => {
    await expect(
      runInToolEgress(["api.example.com"], () => globalThis.fetch("file:///etc/passwd")),
    ).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("tool egress guard — shared policy", () => {
  test("routes an approved fetch through the SSRF-screened path", async () => {
    // The asymmetry this closes: dev used to hit the raw global fetch, so a
    // declared host resolving to a private IP was screened in production and
    // waved through locally.
    await runInToolEgress(["api.example.com"], () => globalThis.fetch("https://api.example.com/x"));
    expect(ssrfSafeFetch).toHaveBeenCalledOnce();
  });

  test("re-checks the allowlist on redirect hops", async () => {
    await runInToolEgress(["api.example.com"], () => globalThis.fetch("https://api.example.com/x"));
    const opts = ssrfSafeFetch.mock.calls[0]?.[3];
    expect(opts?.isHostAllowed?.("api.example.com")).toBe(true);
    expect(opts?.isHostAllowed?.("evil.example.net")).toBe(false);
  });

  test("applies a timeout signal to the outbound request", async () => {
    await runInToolEgress(["api.example.com"], () => globalThis.fetch("https://api.example.com/x"));
    expect(ssrfSafeFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects a request body over the shared cap", async () => {
    const body = "x".repeat(TOOL_FETCH_MAX_REQUEST_BODY_BYTES + 1);
    await expect(
      runInToolEgress(["api.example.com"], () =>
        globalThis.fetch("https://api.example.com/x", { method: "POST", body }),
      ),
    ).rejects.toThrow(/Request body exceeds/);
    expect(inner).not.toHaveBeenCalled();
  });

  test("allows a request body under the cap, and forwards it", async () => {
    await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch("https://api.example.com/x", { method: "POST", body: "hello" }),
    );
    const init = ssrfSafeFetch.mock.calls[0]?.[1];
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe("hello");
    expect(init?.method).toBe("POST");
  });

  test("fails a response that streams past the shared cap", async () => {
    // 1 byte per chunk would take 4 million pulls, so emit oversized chunks.
    const chunk = new Uint8Array(1024 * 1024);
    inner.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
        ),
    );

    const resp = await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch("https://api.example.com/big"),
    );

    await expect(resp.text()).rejects.toThrow(/exceeds .* byte limit/);
  });

  test("passes a response under the cap through intact", async () => {
    inner.mockImplementation(async () => new Response("small body"));
    const resp = await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch("https://api.example.com/x"),
    );
    expect(await resp.text()).toBe("small body");
  });

  test("preserves response status and headers through the cap wrapper", async () => {
    inner.mockImplementation(
      async () => new Response("x", { status: 201, headers: { "x-test": "1" } }),
    );
    const resp = await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch("https://api.example.com/x"),
    );
    expect(resp.status).toBe(201);
    expect(resp.headers.get("x-test")).toBe("1");
  });

  test("rejects past the shared concurrency cap", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    inner.mockImplementation(async () => {
      await gate;
      return new Response("ok");
    });

    const results = runInToolEgress(["api.example.com"], () =>
      Promise.allSettled(
        Array.from({ length: TOOL_FETCH_MAX_CONCURRENT + 1 }, () =>
          globalThis.fetch("https://api.example.com/x"),
        ),
      ),
    );
    release();
    const settled = await results;

    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/concurrent limit/);
  });

  test("frees a concurrency slot once a fetch settles", async () => {
    await runInToolEgress(["api.example.com"], async () => {
      for (let i = 0; i < TOOL_FETCH_MAX_CONCURRENT + 2; i++) {
        await globalThis.fetch("https://api.example.com/x");
      }
    });
    expect(inner).toHaveBeenCalledTimes(TOOL_FETCH_MAX_CONCURRENT + 2);
  });
});

describe("tool egress guard — scoping", () => {
  test("is idempotent when installed repeatedly", async () => {
    installToolFetchGuard();
    installToolFetchGuard();
    await runInToolEgress(["api.example.com"], () => globalThis.fetch("https://api.example.com/x"));
    // A double wrap would run the policy twice and call ssrfSafeFetch twice.
    expect(ssrfSafeFetch).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
  });

  test("scopes the policy per async context, not per process", async () => {
    const [a, b] = await Promise.allSettled([
      runInToolEgress(["a.example.com"], () => globalThis.fetch("https://a.example.com/x")),
      runInToolEgress(["b.example.com"], () => globalThis.fetch("https://a.example.com/x")),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
  });

  test("leaves the scope after the tool call settles", async () => {
    await runInToolEgress(["api.example.com"], async () => undefined);
    await globalThis.fetch("https://anything.example.net/x");
    expect(inner).toHaveBeenCalledOnce();
  });
});

describe("tool egress guard — undici pairing", () => {
  test("pairs the SSRF dispatcher with its own undici, not the runtime's", async () => {
    // `ssrfSafeFetch` attaches a dispatcher built from *this package's* undici
    // on every hostname request. Node's global `fetch` is backed by the undici
    // bundled into the runtime — a different major — and rejects that
    // dispatcher with `InvalidArgumentError: invalid onRequestStart method`,
    // which surfaces as a bare `TypeError: fetch failed`. Because a dispatcher
    // is attached to every hostname, handing the global in here breaks *all*
    // tool-code egress at once, so this guard has to hold at the call site and
    // not just on `performToolFetch`'s default.
    await runInToolEgress(["api.example.com"], () =>
      globalThis.fetch("https://api.example.com/thing"),
    );

    expect(ssrfSafeFetch).toHaveBeenCalledOnce();
    const handedTo = ssrfSafeFetch.mock.calls[0]?.[2];
    expect(handedTo).toBe(pinnedFetch);
    expect(handedTo).not.toBe(globalThis.fetch);
    expect(handedTo).not.toBe(realFetch);
  });
});

describe("exemptFromToolEgress", () => {
  test("lets an exempt object's methods fetch from inside a tool scope", async () => {
    // Stands in for a BYO pinecone provider: in the guest these are RPC
    // methods, so production never asks the author to list a storage endpoint.
    const store = {
      async load() {
        await globalThis.fetch("https://storage.example.net/bucket");
        return "loaded";
      },
    };
    const exempt = exemptFromToolEgress(store);

    await expect(runInToolEgress([], () => exempt.load())).resolves.toBe("loaded");
  });

  test("does not exempt the surrounding tool code", async () => {
    const exempt = exemptFromToolEgress({ noop: () => undefined });

    await expect(
      runInToolEgress([], async () => {
        exempt.noop();
        return globalThis.fetch("https://evil.example.net/x");
      }),
    ).rejects.toThrow(/not allowed/);
  });

  test("passes non-function properties through unchanged", () => {
    const exempt = exemptFromToolEgress({ name: "db", nested: { a: 1 } });
    expect(exempt.name).toBe("db");
    expect(exempt.nested).toEqual({ a: 1 });
  });

  test("preserves behavior of a real Vector instance", async () => {
    const vector = exemptFromToolEgress(createMemoryVector({ namespace: "t" }));
    await vector.upsert("1", "the quick brown fox");
    const hits = await vector.query("the quick brown fox", { topK: 1 });
    expect(hits[0]?.id).toBe("1");
  });
});
