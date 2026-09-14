// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createMockToolContext, fakeFetch } from "./_test-utils.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import { SESSION_NOTES_TTL_MS } from "./session-notes.ts";

/**
 * Invoke the host-side run_code def. run_code no longer executes on the host —
 * real execution happens inside the guest sandbox (see deno-harness). This
 * host-side def is a guard that refuses to evaluate code.
 */
/** A `vi.fn()` standing in for `fetch`, however its return was inferred. */
type MockFetch = { mock: { calls: unknown[] } };

/**
 * The `[url, init]` pair a mocked fetch recorded. `vi.fn()` types its call
 * tuple from its own inferred signature rather than from the `fetch` call
 * site, so reading it back needs a cast — keep it at this one seam; the
 * escape-hatch ratchet counts every occurrence.
 */
function firstFetchCall(mockFetch: MockFetch): [string, RequestInit] {
  return mockFetch.mock.calls[0] as unknown as [string, RequestInit];
}

function runCode(code: string): Promise<unknown> {
  const { defs } = resolveAllBuiltins(["run_code"]);
  return defs.run_code?.execute({ code }, createMockToolContext()) as Promise<unknown>;
}

describe("resolveAllBuiltins schemas", () => {
  test("returns requested tools", () => {
    const { schemas } = resolveAllBuiltins([
      "web_search",
      "visit_webpage",
      "run_code",
      "fetch_json",
    ]);
    expect(schemas).toHaveLength(4);
    const names = schemas.map((s) => s.name);
    expect(names).toContain("web_search");
    expect(names).toContain("visit_webpage");
    expect(names).toContain("run_code");
    expect(names).toContain("fetch_json");
  });

  test("returns empty for no tools", () => {
    const { schemas } = resolveAllBuiltins([]);
    expect(schemas).toHaveLength(0);
  });

  test("unknown tool name returns empty", () => {
    const { schemas } = resolveAllBuiltins(["nonexistent_tool"]);
    expect(schemas).toHaveLength(0);
  });
});

describe("resolveAllBuiltins defs", () => {
  test("returns tool defs with execute functions", () => {
    const { defs } = resolveAllBuiltins(["web_search", "fetch_json"]);
    expect(Object.keys(defs)).toEqual(["web_search", "fetch_json"]);
    expect(defs.web_search?.execute).toBeTypeOf("function");
    expect(defs.fetch_json?.execute).toBeTypeOf("function");
  });

  test("unknown tool name is skipped", () => {
    const { defs } = resolveAllBuiltins(["nonexistent_tool"]);
    expect(Object.keys(defs)).toHaveLength(0);
  });

  test("an Object.prototype key is an unknown name, not a phantom tool", () => {
    // The registries are object literals, so a truthy index walked the
    // prototype: `constructor` reached `Object` and was INVOKED as a factory,
    // declaring a tool with no `execute`, and `toString` returned the string
    // "[object Object]", which crashed agentToolsToSchemas on `"parameters" in
    // def`. Reachable through /runtime's untyped `builtinTools`.
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const { defs, schemas, guidance } = resolveAllBuiltins([name]);
      expect(defs).toEqual({});
      expect(schemas).toEqual([]);
      expect(guidance).toEqual([]);
    }
  });

  // ─── run_code (host-side guard) ─────────────────────────────────────────
  // run_code executes untrusted JS and now runs ONLY inside the guest sandbox
  // (Modal/Deno) — see deno-harness.test.ts for execution coverage. The
  // host-side def must never evaluate code; it returns an error instead.

  test("run_code is registered with schema and guidance", () => {
    const { defs, schemas, guidance } = resolveAllBuiltins(["run_code"]);
    expect(defs.run_code?.execute).toBeTypeOf("function");
    expect(schemas.map((s) => s.name)).toContain("run_code");
    expect(guidance.some((g) => g.includes("run_code"))).toBe(true);
  });

  test("run_code does not execute code on the host", async () => {
    const result = await runCode('console.log("hello")');
    expect(result).toEqual({
      error:
        "run_code is only available in the sandboxed runtime and cannot run in this environment.",
    });
  });

  test("run_code refuses even benign code on the host (no evaluation)", async () => {
    // A payload that WOULD have escaped the old node:vm sandbox must never be
    // evaluated on the host — the guard returns before any execution.
    const result = await runCode('console.log.constructor("return process")().env');
    expect(result).toHaveProperty("error");
    expect(result as { error: string }).not.toHaveProperty("env");
  });

  // ─── fetch_json ────────────────────────────────────────────────────────

  test("fetch_json fetches and returns JSON", async () => {
    const mockData = { name: "test", value: 42 };
    const mockFetch = () => Promise.resolve(new Response(JSON.stringify(mockData)));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/data" }, ctx);
    expect(result).toEqual(mockData);
  });

  test("fetch_json returns error for non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/fail" }, ctx);
    expect(result).toEqual({
      error: "HTTP 500 Internal Server Error",
      url: "https://api.example.com/fail",
    });
  });

  test("fetch_json returns error for invalid JSON response", async () => {
    const mockFetch = () => Promise.resolve(new Response("not-json"));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/text" }, ctx);
    expect(result).toEqual({
      error: "Response was not valid JSON",
      url: "https://api.example.com/text",
    });
  });

  test("fetch_json refuses an over-cap body without buffering it whole", async () => {
    // MAX_JSON_BYTES is 1 MB. The stream offers 4 MB and is pulled lazily, so
    // the `await resp.text()` this replaced would have read every chunk before
    // measuring — the cap bounded what was KEPT, not what a prompt-injected URL
    // could make the host read.
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 64) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(() => Promise.resolve(new Response(body))),
    });
    const result = await defs.fetch_json?.execute(
      { url: "https://api.example.com/huge" },
      createMockToolContext(),
    );
    expect(result).toEqual({ error: "Response too large", url: "https://api.example.com/huge" });
    // 1 MB of 64 KiB chunks is 16, plus the one past the budget and the
    // stream's own read-ahead.
    expect(pulled).toBeLessThanOrEqual(19);
  });

  test("fetch_json passes allowed custom headers to fetch", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    await defs.fetch_json?.execute(
      {
        url: "https://api.example.com",
        headers: { Accept: "application/json", "x-api-key": "tok" },
      },
      ctx,
    );
    const callArgs = firstFetchCall(mockFetch);
    expect(callArgs[1]).toMatchObject({
      headers: { Accept: "application/json", "x-api-key": "tok" },
    });
  });

  test("fetch_json blocks dangerous headers like Authorization", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    await defs.fetch_json?.execute(
      {
        url: "https://api.example.com",
        headers: { Authorization: "Bearer tok", Accept: "application/json" },
      },
      ctx,
    );
    const callArgs = firstFetchCall(mockFetch);
    // Authorization should be stripped, Accept should remain
    expect(callArgs[1]).toMatchObject({ headers: { Accept: "application/json" } });
    expect((callArgs[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("fetch_json delegates fetch without SSRF checks — platform adapter handles it", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    // SDK tools pass through — SSRF is enforced by the network adapter in
    // the platform sandbox and by the runtime's fetch in self-hosted mode.
    await defs.fetch_json?.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx);
    expect(mockFetch).toHaveBeenCalled();
  });

  // ─── web_search ────────────────────────────────────────────────────────

  /** A minimal DDG HTML results page: two result anchors with snippets. */
  const ddgHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F1&rut=abc">Result <b>1</b></a>
      <a class="result__snippet" href="#">Desc &amp; 1</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/2">Result 2</a>
      <a class="result__snippet" href="#">Desc&nbsp;2</a>
    </div>`;

  test("web_search needs no API key", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(ddgHtml)));
    const { defs } = resolveAllBuiltins(["web_search"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext({ env: {} });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  test("web_search returns error on non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const { defs } = resolveAllBuiltins(["web_search"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "Search request failed: 500 Internal Server Error" });
  });

  test("web_search parses DDG results, decoding redirect URLs and entities", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(ddgHtml)));
    const { defs } = resolveAllBuiltins(["web_search"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.web_search?.execute({ query: "aai sdk", max_results: 2 }, ctx);
    expect(result).toEqual([
      // uddg redirect decoded to the real URL; <b> highlight stripped in-word.
      { title: "Result 1", url: "https://example.com/1", description: "Desc & 1" },
      { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
    ]);
    const fetchUrl = firstFetchCall(mockFetch)[0];
    expect(fetchUrl).toContain("html.duckduckgo.com");
    expect(fetchUrl).toContain("q=aai+sdk");
  });

  test("web_search caps max_results", async () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `<a class="result__a" href="https://example.com/${i}">R${i}</a>`,
    ).join("\n");
    const mockFetch = () => Promise.resolve(new Response(many));
    const { defs } = resolveAllBuiltins(["web_search"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = (await defs.web_search?.execute(
      { query: "q", max_results: 50 },
      ctx,
    )) as unknown[];
    expect(result).toHaveLength(10);
  });

  test("web_search surfaces a bot-detection challenge as an error", async () => {
    const challenge = '<form id="challenge-form">are you a human</form>';
    const mockFetch = () => Promise.resolve(new Response(challenge));
    const { defs } = resolveAllBuiltins(["web_search"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.web_search?.execute({ query: "q" }, ctx);
    expect(result).toMatchObject({ error: expect.stringContaining("bot-detection") });
  });

  // ─── visit_webpage ─────────────────────────────────────────────────────

  test("visit_webpage returns content for successful fetch", async () => {
    const html = "<html><body><p>Hello World</p></body></html>";
    const mockFetch = () => Promise.resolve(new Response(html));
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute(
      { url: "https://example.com" },
      ctx,
    )) as Record<string, unknown>;
    expect(result.url).toBe("https://example.com");
    expect(result.content).toBeTypeOf("string");
    expect((result.content as string).length).toBeGreaterThan(0);
  });

  test("visit_webpage returns error for non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 404, statusText: "Not Found" }));
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = await defs.visit_webpage?.execute({ url: "https://example.com/missing" }, ctx);
    expect(result).toEqual({
      error: "Failed to fetch: 404 Not Found",
      url: "https://example.com/missing",
    });
  });

  test("visit_webpage truncates content exceeding MAX_PAGE_CHARS", async () => {
    // MAX_PAGE_CHARS is 10_000. Create content that, when converted from HTML,
    // will exceed that limit.
    const longText = "A".repeat(15_000);
    const html = `<html><body><p>${longText}</p></body></html>`;
    const mockFetch = () => Promise.resolve(new Response(html));
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute(
      { url: "https://example.com" },
      ctx,
    )) as Record<string, unknown>;
    expect((result.content as string).length).toBeLessThanOrEqual(10_000);
    expect(result.truncated).toBe(true);
    expect(typeof result.totalChars).toBe("number");
  });

  // ─── think ─────────────────────────────────────────────────────────────

  test("think is a no-op that returns ok and never touches db or fetch", async () => {
    const { defs, schemas, guidance } = resolveAllBuiltins(["think"]);
    expect(schemas.map((s) => s.name)).toContain("think");
    expect(guidance.some((g) => g.includes("think"))).toBe(true);
    // db is a throwing stub in the mock context — a no-op must not touch it.
    const result = await defs.think?.execute(
      { thought: "check the policy first" },
      createMockToolContext(),
    );
    expect(result).toBe("ok");
  });

  // ─── remember / recall ─────────────────────────────────────────────────
  //
  // The notes store is module-level (per host process), so each test uses
  // session ids unique to it — there is no per-test store to construct.

  test("remember stores notes per session and recall reads them back", async () => {
    const { defs } = resolveAllBuiltins(["remember", "recall"]);
    const ctx = createMockToolContext({ sessionId: "notes-basic" });

    await defs.remember?.execute({ key: "user_id", value: "usr_123" }, ctx);
    const saved = await defs.remember?.execute({ key: "res_code", value: "BOB12" }, ctx);
    expect(saved).toEqual({
      saved: "res_code",
      notes: { user_id: "usr_123", res_code: "BOB12" },
    });

    expect(await defs.recall?.execute({ key: "user_id" }, ctx)).toEqual({
      key: "user_id",
      value: "usr_123",
    });
    expect(await defs.recall?.execute({}, ctx)).toEqual({
      notes: { user_id: "usr_123", res_code: "BOB12" },
    });
    expect(await defs.recall?.execute({ key: "missing" }, ctx)).toEqual({
      key: "missing",
      value: null,
    });
  });

  test("remember overwrites a key and notes are isolated per session", async () => {
    const { defs } = resolveAllBuiltins(["remember", "recall"]);
    const s1 = createMockToolContext({ sessionId: "notes-iso-1" });
    const s2 = createMockToolContext({ sessionId: "notes-iso-2" });

    await defs.remember?.execute({ key: "zip", value: "19122" }, s1);
    await defs.remember?.execute({ key: "zip", value: "94103" }, s1);
    expect(await defs.recall?.execute({ key: "zip" }, s1)).toEqual({ key: "zip", value: "94103" });
    expect(await defs.recall?.execute({}, s2)).toEqual({ notes: {} });
  });

  test("two concurrent remember calls both persist", async () => {
    const { defs } = resolveAllBuiltins(["remember", "recall"]);
    const ctx = createMockToolContext({ sessionId: "notes-concurrent" });

    // One LLM step's tool calls execute concurrently (pipeline streamText runs
    // them in parallel). Map updates are synchronous, so no per-key lock is
    // needed for both writes to land.
    await Promise.all([
      defs.remember?.execute({ key: "user_id", value: "usr_1" }, ctx),
      defs.remember?.execute({ key: "res_code", value: "BOB12" }, ctx),
    ]);

    expect(await defs.recall?.execute({}, ctx)).toEqual({
      notes: { user_id: "usr_1", res_code: "BOB12" },
    });
  });

  test("notes expire after the session-notes TTL", async () => {
    vi.useFakeTimers();
    try {
      const { defs } = resolveAllBuiltins(["remember", "recall"]);
      const ctx = createMockToolContext({ sessionId: "notes-ttl" });

      await defs.remember?.execute({ key: "user_id", value: "usr_123" }, ctx);
      vi.advanceTimersByTime(SESSION_NOTES_TTL_MS - 1);
      expect(await defs.recall?.execute({}, ctx)).toEqual({ notes: { user_id: "usr_123" } });

      vi.advanceTimersByTime(2);
      expect(await defs.recall?.execute({}, ctx)).toEqual({ notes: {} });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── calculate ─────────────────────────────────────────────────────────

  test("calculate evaluates expressions and reports errors in-band", async () => {
    const { defs, guidance } = resolveAllBuiltins(["calculate"]);
    const ctx = createMockToolContext();
    expect(guidance.some((g) => g.includes("calculate"))).toBe(true);
    expect(await defs.calculate?.execute({ expression: "(75 + 120.40) * 1.0725" }, ctx)).toEqual({
      expression: "(75 + 120.40) * 1.0725",
      result: 209.5665,
    });
    const bad = (await defs.calculate?.execute({ expression: "1 +" }, ctx)) as { error: string };
    expect(bad.error).toMatch(/unexpected/i);
  });

  test("visit_webpage adds NO redirect screening of its own", async () => {
    // A redirect, modelled the way a real `fetch` surfaces one: the hop is
    // followed inside the fetch implementation, so the caller sees a SINGLE
    // 200 whose `url` is the final address. Re-screening that address is
    // `ssrfSafeFetch`'s job (`ssrf-redirects.test.ts`) — what this pins is
    // that the tool adds none, which the previous version could not see
    // because its fake returned a plain 200 and no redirect ever happened.
    const START = "https://evil.com/redirect";
    const TARGET = "http://169.254.169.254/latest/meta-data/iam/";
    const requested: string[] = [];
    const mockFetch = vi.fn(async (url: string) => {
      requested.push(url);
      if (url !== START) return new Response("", { status: 404 });
      const body = new Response("<html><body>metadata: leaked-iam-creds</body></html>", {
        status: 200,
      });
      Object.defineProperty(body, "url", { value: TARGET, configurable: true });
      return body;
    });
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
      fetch: fakeFetch(mockFetch),
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute({ url: START }, ctx)) as {
      url: string;
      content: string;
    };

    // One request, and no second (re-validating) one.
    expect(requested).toEqual([START]);
    // The private target's body comes straight back…
    expect(result.content).toContain("leaked-iam-creds");
    // …attributed to the URL the model asked for, so the address the bytes
    // actually came from is not surfaced to anything downstream either.
    expect(result.url).toBe(START);
  });
});
