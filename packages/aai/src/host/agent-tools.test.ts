// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { DefaultToolResult } from "../sdk/types.ts";
import { isToolFailure, type ToolFailure } from "../sdk/utils.ts";
import { fetchJson, visitWebpage, webSearch } from "./agent-tools.ts";

/**
 * These are thin wrappers over the same factories the model-facing builtins
 * use. What is worth pinning is that they REACH those factories — i.e. that a
 * tool author gets the screening, header stripping and size caps rather than
 * a bare `fetch` — so the tests drive real behaviour through an injected
 * network rather than asserting on the wrapper's shape.
 */
describe("callable builtins", () => {
  test("fetchJson parses a JSON body", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ price: 42 }), { status: 200 }));
    expect(await fetchJson("https://api.example.com/quote", { fetch })).toEqual({ price: 42 });
  });

  test("fetchJson reports an HTTP failure instead of throwing", async () => {
    // Matches the model-facing builtin: a tool handing this straight back to
    // the model should say something useful, not fail the turn.
    const fetch = vi.fn(
      async () => new Response("nope", { status: 503, statusText: "Unavailable" }),
    );
    const result = (await fetchJson("https://api.example.com/quote", { fetch })) as {
      error?: string;
    };
    expect(result.error).toContain("503");
  });

  test("fetchJson strips credential headers the caller passed", async () => {
    // The same sanitizer the builtin uses. A tool author forwarding request
    // headers wholesale must not leak an Authorization to a third-party host.
    const fetch = vi.fn(
      async (_url: unknown, _init?: unknown) => new Response("{}", { status: 200 }),
    );
    await fetchJson("https://api.example.com/x", {
      fetch,
      headers: { Authorization: "Bearer secret", Accept: "application/json" },
    });
    const init = fetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.Accept).toBe("application/json");
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  test("visitWebpage and webSearch are callable", async () => {
    const fetch = vi.fn(
      async () => new Response("<html><body>hello</body></html>", { status: 200 }),
    );
    await expect(visitWebpage("https://example.com", { fetch })).resolves.toBeDefined();
    await expect(webSearch("anything", { fetch })).resolves.toBeDefined();
  });

  test("accepts the bag form as well as positional, with ONE name for the cap", () => {
    // `maxResults` lives in the bag and nowhere else. It used to be settable as
    // `max_results` too — the only snake_case identifier on this TypeScript
    // surface — and again in the second parameter, so one option had three ways
    // to arrive and two of them were undiscoverable from the other.
    const fetch = vi.fn(async () => new Response("<html>ok</html>", { status: 200 }));
    return Promise.all([
      expect(webSearch({ query: "x", maxResults: 2, fetch })).resolves.toBeDefined(),
      expect(webSearch("x", { fetch })).resolves.toBeDefined(),
      expect(visitWebpage({ url: "https://example.com", fetch })).resolves.toBeDefined(),
      expect(fetchJson({ url: "https://example.com", fetch })).resolves.toBeDefined(),
    ]);
  });

  test("the object form no longer discards a second argument", async () => {
    // `typeof x === "string" ? { url: x, ...options } : x` dropped `options`
    // whenever the object form was used, so the two shapes the module documents
    // as equivalent were not: this call reached the REAL network instead of the
    // injected one, and the headers went nowhere.
    const fetch = vi.fn(
      async (_url: unknown, _init?: unknown) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(await fetchJson({ url: "https://api.example.com/x" }, { fetch })).toEqual({ ok: true });
    const init = fetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init).toBeDefined();

    await fetchJson({ url: "https://api.example.com/y" }, { fetch, headers: { Accept: "x/y" } });
    const second = fetch.mock.calls[1]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(second?.headers?.Accept).toBe("x/y");

    // The object's own fields still win over the trailing options.
    await fetchJson(
      { url: "https://api.example.com/z", headers: { Accept: "from/object" }, fetch },
      { headers: { Accept: "from/options" } },
    );
    const third = fetch.mock.calls[2]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(third?.headers?.Accept).toBe("from/object");
  });

  test("the result needs no cast, once the failure arm is out of the way", async () => {
    // `Promise<unknown>` made every real call site write `as any` — the same
    // defect useToolResult had. Reading a field must just compile, and it does:
    // past the narrowing the field is `any`, so nothing here is annotated and
    // nothing is cast.
    const fetch = vi.fn(async () => new Response(JSON.stringify({ price: 1 }), { status: 200 }));
    const quote = await fetchJson("https://api.example.com/q", { fetch });
    if (isToolFailure(quote)) expect.fail(`unexpected failure: ${quote.error}`);
    const price: number = quote.price;
    expect(price).toBe(1);
    // Any depth, still no cast. Asserted on the TYPE and not on a value:
    // `expectTypeOf` evaluates its argument, so reading two levels into a shape
    // this test never staged is a runtime error rather than a type one.
    expectTypeOf<typeof quote>().toEqualTypeOf<Record<string, DefaultToolResult>>();
    // And a type argument still gives real checking when you want it — including
    // the failure arm, which is the whole point: naming a shape is what makes the
    // compiler ask about `{ error }`.
    const typed = await fetchJson<{ price: number }>("https://api.example.com/q", { fetch });
    if (isToolFailure(typed)) expect.fail(`unexpected failure: ${typed.error}`);
    expect(typed.price).toBe(1);
  });

  test("an HTTP failure ANSWERS with a ToolFailure rather than throwing", async () => {
    // The contract these three are model-facing for: a tool that hands the result
    // straight back to the model should say something useful, not fail the turn.
    const fetch = vi.fn(async () => new Response("nope", { status: 503 }));
    const answer = await fetchJson<{ price: number }>("https://api.example.com/q", { fetch });
    expect(isToolFailure(answer)).toBe(true);
  });

  test("a caller that named a shape has to NARROW — the union is in the type", async () => {
    // The defect this pins: typed `Promise<T>`, three of three callers in this
    // repo wrote `(result.results ?? [])` and turned a live `403` into "the web
    // has nothing". A type-level assertion, because the runtime already passes.
    expectTypeOf<Awaited<ReturnType<typeof webSearch<{ results: string[] }>>>>().toEqualTypeOf<
      { results: string[] } | ToolFailure
    >();
    expectTypeOf<Awaited<ReturnType<typeof visitWebpage<string>>>>().toEqualTypeOf<
      string | ToolFailure
    >();
    // And an UNNAMED call is the case that used to escape entirely: `T`
    // defaulted to `DefaultToolResult`, which is `any`, and `any | ToolFailure`
    // is `any` — so the union above was erased for exactly the callers that had
    // not thought about failure. `const a = await fetchJson(url);
    // a.no.such.field` was zero errors. Asserted through a real call, because
    // that is where the default is applied.
    const fetch = vi.fn(async () => new Response(JSON.stringify({ price: 1 }), { status: 200 }));
    const loose = await fetchJson("https://api.example.com/q", { fetch });
    expectTypeOf(loose).not.toBeAny();
    expectTypeOf(loose).toEqualTypeOf<Record<string, DefaultToolResult> | ToolFailure>();
    // What that buys, stated as the property rather than as a suppressed error:
    // the only field the union agrees on is `error`, so `loose.price` before the
    // narrowing does not compile and the message names `ToolFailure`.
    expectTypeOf(loose).toHaveProperty("error");
    expectTypeOf(loose).not.toHaveProperty("price");
    // The value is still there for a caller that does narrow.
    expect(isToolFailure(loose) ? undefined : loose.price).toBe(1);
  });

  test("a signal reaches the fetch, combined with the builtin's own deadline", async () => {
    // Without this the only way to abort a page read was a raw `fetch` — i.e.
    // giving up the screening, the header stripping and the size caps to comply
    // with "pass ctx.signal to anything slow".
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const controller = new AbortController();
    await fetchJson("https://api.example.com/q", { fetch, signal: controller.signal });
    // `fetchCappedText` always sets its own FETCH_TIMEOUT_MS deadline, so what
    // arrives is the COMBINATION rather than the caller's signal — the point
    // being that aborting the caller's still aborts the request.
    const combined = seen[0];
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined?.aborted).toBe(false);
    controller.abort();
    expect(combined?.aborted).toBe(true);
  });

  test("an abort REJECTS rather than answering a ToolFailure", async () => {
    // A cancelled turn has no model left to tell, and the tool's own await is
    // being unwound — same shape as the per-request timeout, which has always
    // thrown.
    const fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal | null }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const controller = new AbortController();
    const pending = visitWebpage({ url: "https://example.com", fetch, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  test("the signal rides the bag form of all three", async () => {
    // The bag is the shape agents reach for first, so an option only the
    // trailing argument accepts is an option half the callers cannot find.
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
      seen.push(init?.signal);
      return new Response("<html>ok</html>", { status: 200 });
    });
    const { signal } = new AbortController();
    await webSearch({ query: "x", fetch, signal });
    await visitWebpage({ url: "https://example.com", fetch, signal });
    await fetchJson({ url: "https://example.com", fetch, signal });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});
