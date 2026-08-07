// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, settle, sseResponse, stubFetch } from "./_test-utils.ts";
import { ApiError, api, isTransientError, parseSecrets } from "./api.ts";

describe("parseSecrets", () => {
  test("parses KEY=value lines", () => {
    expect(parseSecrets("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  test("strips surrounding quotes", () => {
    // The publish panel invites pasting from a .env file, where quoting a
    // value is normal — the quotes are syntax, not part of the secret.
    expect(parseSecrets("A=\"pk-abc\"\nB='sk-xyz'")).toEqual({ A: "pk-abc", B: "sk-xyz" });
  });

  test("ignores comments and blank lines", () => {
    expect(parseSecrets("# a comment\n\nA=1\n   # indented\n")).toEqual({ A: "1" });
    // The dangerous one: a commented-out secret must not come back to life.
    expect(parseSecrets("# B=old-key\nA=1")).toEqual({ A: "1" });
  });

  test("accepts an `export ` prefix", () => {
    expect(parseSecrets("export A=1")).toEqual({ A: "1" });
  });

  test("keeps '=' inside a value; '#' needs quoting (.env comment syntax)", () => {
    // Base64 and URLs routinely contain '='. An unquoted '#' starts an
    // inline comment in .env syntax — quoting the value keeps it literal.
    expect(parseSecrets('A=b=c==\nB=https://x/y#frag\nC="https://x/y#frag"')).toEqual({
      A: "b=c==",
      B: "https://x/y",
      C: "https://x/y#frag",
    });
  });

  test("keeps multi-line quoted values intact (PEM keys, JSON)", () => {
    // The whole point of real .env parsing: a pasted PEM key or
    // service-account JSON spans lines inside one quoted value.
    const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";
    expect(parseSecrets(`A="${pem}"\nB=1`)).toEqual({ A: pem, B: "1" });
  });

  test("expands \\n escapes in double-quoted values only", () => {
    expect(parseSecrets("A=\"line1\\nline2\"\nB='raw\\nvalue'")).toEqual({
      A: "line1\nline2",
      B: "raw\\nvalue",
    });
  });

  test("skips lines with no key", () => {
    expect(parseSecrets("=novalue\njusttext\nA=1")).toEqual({ A: "1" });
  });
});

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("authConfig is public (no bearer) and returns the login mode", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ mode: "dev" }));
    await expect(api.authConfig()).resolves.toEqual({ mode: "dev" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit?];
    expect(url).toBe("/studio/auth");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });

  test("getAccount sends the session bearer", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ email: "a@b.c", hasKey: false }));
    await expect(api.getAccount("session.jwt.tok")).resolves.toEqual({
      email: "a@b.c",
      hasKey: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/studio/account");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session.jwt.tok");
  });

  test("putAccountKey PUTs the key as JSON under the session bearer", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    await expect(api.putAccountKey("session.jwt.tok", "users-key")).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/studio/account/key");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ apiKey: "users-key" }));
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session.jwt.tok");
  });

  test("sends the bearer key and parses the response", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ projects: ["a", "b"] }));
    await expect(api.listProjects("sk-123")).resolves.toEqual(["a", "b"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/studio/projects");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-123");
  });

  test("POST bodies are JSON with Content-Type set", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ name: "contact-form-x7k2mq", files: {} }));
    await api.createProject("k", { prompt: "build a contact form" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    // The prompt seeds the server-generated name — the client never names.
    expect(init.body).toBe(JSON.stringify({ prompt: "build a contact form" }));
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  test("createProject with no prompt sends an empty body (server picks words)", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ name: "brave-cats-fly-a1b2c3", files: {} }));
    await api.createProject("k", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("{}");
  });

  test("project segments are URL-encoded", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    await api.getProject("k", "my project");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/studio/projects/my%20project");
  });

  test("getProject / writeFile / deploy hit their routes", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true, slug: "s", url: "u", files: {} }));
    await api.getProject("k", "p");
    await api.writeFile("k", "p", "agent.ts", "code");
    await api.deploy("k", "p");
    const calls = fetchMock.mock.calls.map((c) => {
      const [url, init] = c as [string, RequestInit | undefined];
      return `${init?.method ?? "GET"} ${url}`;
    });
    expect(calls).toEqual([
      "GET /studio/projects/p",
      "PUT /studio/projects/p/file",
      "POST /studio/projects/p/deploy",
    ]);
  });

  test("getChat hits the chat route with the bearer key and unwraps messages", async () => {
    const history = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    const fetchMock = stubFetch(() => jsonResponse({ messages: history }));
    await expect(api.getChat("sk-123", "my project")).resolves.toEqual(history);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/studio/projects/my%20project/chat");
    expect(init.method ?? "GET").toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-123");
  });

  test("createChatSession carries a per-attempt timeout signal", async () => {
    // A broker request issued mid-restart can hang instead of failing; the
    // deadline is what lets the query layer ever retry it.
    const fetchMock = stubFetch(() => jsonResponse({ url: "http://s/studio/chat" }));
    await api.createChatSession("k", "p");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/studio/projects/p/session");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("the two reads that gate the whole app carry a per-attempt timeout", async () => {
    // Both can HANG rather than fail when the server is restarting or
    // saturated, and a hung fetch cannot be retried away: the query layer
    // folds a refetch into the in-flight promise, so a Try again button is a
    // no-op until the attempt settles. Without these the studio sits on
    // "Loading…" (or, for the auth config, an empty page) forever.
    const fetchMock = stubFetch({
      "/studio/auth": () => jsonResponse({ mode: "dev" }),
      "/studio/account": () => jsonResponse({ hasKey: true }),
    });
    await api.authConfig();
    await api.getAccount("k");
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit | undefined];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    }
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  test("secret endpoints hit the platform's own agent routes", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true, vars: ["A"], keys: ["A"] }));
    await api.listSecrets("k", "my-agent");
    await api.putSecrets("k", "my-agent", { OPENAI_API_KEY: "x" });
    await api.deleteSecret("k", "my-agent", "OPENAI_API_KEY");
    const calls = fetchMock.mock.calls.map((c) => {
      const [url, init] = c as [string, RequestInit | undefined];
      return `${init?.method ?? "GET"} ${url}`;
    });
    expect(calls).toEqual([
      "GET /my-agent/secret",
      "PUT /my-agent/secret",
      "DELETE /my-agent/secret/OPENAI_API_KEY",
    ]);
    // Bearer-authenticated like the studio project routes.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer k");
  });

  test("status is unauthenticated and returns the body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ llm: true, provider: "assemblyai" }));
    await expect(api.status()).resolves.toEqual({ llm: true, provider: "assemblyai" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("/studio/status");
    expect(init).toBeUndefined();
  });

  test("non-OK responses throw ApiError with the server's error message", async () => {
    stubFetch(() => jsonResponse({ error: "no such project" }, 404));
    const err = await api.getProject("k", "p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("no such project");
  });

  test("a 2xx with a non-JSON body throws ApiError, not a raw SyntaxError", async () => {
    // A proxy can answer 200 with an HTML page; callers match on ApiError.
    stubFetch(() => new Response("<html>ok?</html>", { status: 200 }));
    const err = await api.listProjects("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Server returned an invalid response");
  });

  test("a JSON error body without an `error` field keeps the status message", async () => {
    stubFetch(() => jsonResponse({ detail: "something else" }, 500));
    const err = await api.listProjects("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Request failed (500)");
  });

  test("non-JSON error bodies fall back to the status message", async () => {
    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 502 }));
    const err = await api.listProjects("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe("Request failed (502)");
  });
});

describe("api.agentPageReady", () => {
  test("the agent health route decides whether `/:slug/` is framable", async () => {
    stubFetch({ "/p-preview/health": () => jsonResponse({ status: "ok", slug: "p-preview" }) });
    await expect(api.agentPageReady("p-preview")).resolves.toBe(true);

    stubFetch({ "/p-preview/health": () => jsonResponse({ error: "Not found" }, 404) });
    await expect(api.agentPageReady("p-preview")).resolves.toBe(false);
  });

  test("a rejected fetch reads as not-ready rather than throwing", async () => {
    // The Preview pane polls this; an offline browser must leave it on the
    // pane's own screen, not surface an unhandled rejection.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(api.agentPageReady("p-preview")).resolves.toBe(false);
  });
});

describe("isTransientError", () => {
  test("4xx answers are final — a bad key or missing project can't be retried away", () => {
    expect(isTransientError(new ApiError(401, "unauthorized"))).toBe(false);
    expect(isTransientError(new ApiError(404, "Project not found"))).toBe(false);
  });

  test("408/429 are the transient 4xx", () => {
    expect(isTransientError(new ApiError(408, "request timeout"))).toBe(true);
    expect(isTransientError(new ApiError(429, "rate limited"))).toBe(true);
  });

  test("5xx and settled-without-a-response failures retry (a restarting server)", () => {
    expect(isTransientError(new ApiError(503, "service unavailable"))).toBe(true);
    // A rejected fetch (connection refused) and a timed-out attempt.
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientError(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });
});

describe("api.watchProject", () => {
  test("parses project frames and ignores pings; a closed stream reports down", async () => {
    stubFetch(() =>
      sseResponse([
        'event: project\ndata: {"files":{},"previewStale":true}\n\n',
        "event: ping\ndata: \n\n",
        // A frame split across two reads must reassemble.
        'event: project\ndata: {"files":{},"previewSt',
        'ale":false,"previewVersion":"abc"}\n\n',
      ]),
    );
    const seen: unknown[] = [];
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: (d) => seen.push(d), onDown: down });
    await settle();
    expect(seen).toEqual([
      { files: {}, previewStale: true },
      { files: {}, previewStale: false, previewVersion: "abc" },
    ]);
    // The server closed the stream — the caller resubscribes.
    expect(down).toHaveBeenCalledOnce();
  });

  test("chat frames reach onChat", async () => {
    stubFetch(() =>
      sseResponse([
        'event: project\ndata: {"files":{},"previewStale":true}\n\n',
        'event: chat\ndata: [{"id":"m1","role":"user","parts":[]}]\n\n',
      ]),
    );
    const chats: unknown[] = [];
    api.watchProject("k", "proj", {
      onData: () => undefined,
      onChat: (m) => chats.push(m),
      onDown: () => undefined,
    });
    await settle();
    expect(chats).toEqual([[{ id: "m1", role: "user", parts: [] }]]);
  });

  test("a non-OK response reports down as a transport failure", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 503));
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: () => undefined, onDown: down });
    await settle();
    expect(down).toHaveBeenCalledExactlyOnceWith("transport");
  });

  test.for([401, 403])("a %i reports down as an AUTH failure, not transport", async (status) => {
    // The distinction the caller acts on: retrying a rejected bearer can only
    // loop. One backgrounded tab whose session token expired (supabase-js
    // pauses its refresh ticker on hidden tabs) resubscribed every 3s for
    // three hours — 4,346 401s, each costing a Supabase token verification.
    stubFetch(() => jsonResponse({ error: "unauthorized" }, status));
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: () => undefined, onDown: down });
    await settle();
    expect(down).toHaveBeenCalledExactlyOnceWith("auth");
  });

  test("onOpen fires only when the server accepted the stream", async () => {
    // It is the caller's backoff reset, so it must not fire for a rejection.
    stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const open = vi.fn();
    api.watchProject("k", "proj", {
      onData: () => undefined,
      onOpen: open,
      onDown: () => undefined,
    });
    await settle();
    expect(open).not.toHaveBeenCalled();

    stubFetch(() => sseResponse(['event: project\ndata: {"files":{}}\n\n']));
    api.watchProject("k", "proj", {
      onData: () => undefined,
      onOpen: open,
      onDown: () => undefined,
    });
    await settle();
    expect(open).toHaveBeenCalledOnce();
  });

  test("aborting via the returned unsubscribe does NOT report down", async () => {
    // A never-ending stream: unsubscribe is the only way out.
    stubFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const down = vi.fn();
    const stop = api.watchProject("k", "proj", { onData: () => undefined, onDown: down });
    await settle();
    stop();
    await settle();
    expect(down).not.toHaveBeenCalled();
  });
});

describe("api.watchProjects", () => {
  test("delivers pushed project lists", async () => {
    stubFetch(() =>
      sseResponse(['event: projects\ndata: ["a"]\n\n', 'event: projects\ndata: ["a","b"]\n\n']),
    );
    const lists: string[][] = [];
    const down = vi.fn();
    api.watchProjects("k", { onData: (names) => lists.push(names), onDown: down });
    await settle();
    expect(lists).toEqual([["a"], ["a", "b"]]);
    expect(down).toHaveBeenCalledOnce();
  });
});
