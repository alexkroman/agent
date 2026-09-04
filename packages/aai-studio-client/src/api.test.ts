// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchCall,
  fetchLines,
  jsonResponse,
  settle,
  sseResponse,
  stubFetch,
} from "./_test-utils.ts";
import {
  api,
  CHAT_SESSION_ATTEMPT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  parseSecrets,
  STATUS_ATTEMPT_TIMEOUT_MS,
} from "./api.ts";
import { ApiError, isTransientError } from "./api-error.ts";

// FILE-scoped, not block-scoped. Four of the five `describe`s below install a
// global `fetch` and only this one used to remove it, so the last stub of a
// block outlived it — most recently a rejecting `TimeoutError`. Nothing failed
// only because every later block happened to re-stub first; a test appended to
// `isTransientError`, or a block inserted between two of them, would have run
// against whatever the previous block abandoned.
afterEach(() => {
  vi.unstubAllGlobals();
});

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
  test("authConfig is public (no bearer) and returns the login mode", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ mode: "dev" }));
    await expect(api.authConfig()).resolves.toEqual({ mode: "dev" });
    const { url, init } = fetchCall(fetchMock);
    expect(url).toBe("/studio/auth");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });

  test("getAccount sends the session bearer", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ email: "a@b.c", hasKey: false }));
    await expect(api.getAccount("session.jwt.tok")).resolves.toEqual({
      email: "a@b.c",
      hasKey: false,
    });
    const { url, init } = fetchCall(fetchMock);
    expect(url).toBe("/studio/account");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session.jwt.tok");
  });

  test("putAccountKey PUTs the key as JSON under the session bearer", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    await expect(api.putAccountKey("session.jwt.tok", "users-key")).resolves.toEqual({ ok: true });
    const { url, method, init } = fetchCall(fetchMock);
    expect(url).toBe("/studio/account/key");
    expect(method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ apiKey: "users-key" }));
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session.jwt.tok");
  });

  test("sends the bearer key and parses the response", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ projects: ["a", "b"] }));
    await expect(api.listProjects("sk-123")).resolves.toEqual(["a", "b"]);
    const { url, init } = fetchCall(fetchMock);
    expect(url).toBe("/studio/projects");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-123");
  });

  test("POST bodies are JSON with Content-Type set", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ name: "contact-form-x7k2mq", files: {} }));
    await api.createProject("k", { prompt: "build a contact form" });
    const { method, init } = fetchCall(fetchMock);
    expect(method).toBe("POST");
    // The prompt seeds the server-generated name — the client never names.
    expect(init.body).toBe(JSON.stringify({ prompt: "build a contact form" }));
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  test("createProject with no prompt sends an empty body (server picks words)", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ name: "brave-cats-fly-a1b2c3", files: {} }));
    await api.createProject("k", {});
    expect(fetchCall(fetchMock).init.body).toBe("{}");
  });

  test("project segments are URL-encoded", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    await api.getProject("k", "my project");
    expect(fetchCall(fetchMock).url).toBe("/studio/projects/my%20project");
  });

  test("getProject / writeFile / deploy hit their routes", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true, slug: "s", url: "u", files: {} }));
    await api.getProject("k", "p");
    await api.writeFile("k", "p", "agent.ts", "code");
    await api.deploy("k", "p");
    expect(fetchLines(fetchMock)).toEqual([
      "GET /studio/projects/p",
      "PUT /studio/projects/p/file",
      "POST /studio/projects/p/deploy",
    ]);
  });

  test("getChat hits the chat route with the bearer key and unwraps messages", async () => {
    const history = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    const fetchMock = stubFetch(() => jsonResponse({ messages: history }));
    await expect(api.getChat("sk-123", "my project")).resolves.toEqual(history);
    const { url, method, init } = fetchCall(fetchMock);
    expect(url).toBe("/studio/projects/my%20project/chat");
    expect(method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-123");
  });

  test("createChatSession carries a per-attempt timeout signal", async () => {
    // A broker request issued mid-restart can hang instead of failing; the
    // deadline is what lets the query layer ever retry it.
    const fetchMock = stubFetch(() => jsonResponse({ url: "http://s/studio/chat" }));
    await api.createChatSession("k", "p");
    const { url, init } = fetchCall(fetchMock);
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
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (let index = 0; index < 2; index += 1) {
      const { init } = fetchCall(fetchMock, index);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
    }
  });

  test("secret endpoints hit the PROJECT routes, which write both agents", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true, vars: ["A"], keys: ["A"] }));
    await api.listSecrets("k", "my-project");
    await api.putSecrets("k", "my-project", { OPENAI_API_KEY: "x" });
    await api.deleteSecret("k", "my-project", "OPENAI_API_KEY");
    // The per-slug routes stay the platform primitive; this client no longer
    // knows a project has two agents (see studio-project-slugs.ts).
    expect(fetchLines(fetchMock)).toEqual([
      "GET /studio/projects/my-project/secret",
      "PUT /studio/projects/my-project/secret",
      "DELETE /studio/projects/my-project/secret/OPENAI_API_KEY",
    ]);
    // Bearer-authenticated like the studio project routes.
    const { init } = fetchCall(fetchMock);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer k");
  });

  test("status is unauthenticated and returns the body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ provider: "assemblyai" }));
    await expect(api.status()).resolves.toEqual({ provider: "assemblyai" });
    const { url, init } = fetchCall(fetchMock);
    expect(url).toBe("/studio/status");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });

  test("every request carries a deadline, `/studio/status` included", async () => {
    // H9: a browser fetch has no timeout of its own, so a hung read never
    // settles — no error, no retry, no backoff. `/studio/status` was one of the
    // ~14 that carried none, and it gates the home hero's Send button and the
    // project composer both: one hung read deadened two screens until a reload.
    const fetchMock = stubFetch(() => jsonResponse({}));
    await api.status();
    await api.listProjects("k");
    await api.getProject("k", "p");
    await api.wakePreview("k", "p");
    expect(fetchMock.mock.calls).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      expect(fetchCall(fetchMock, index).init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("the broker's deadline is LONGER than the default, not shorter", async () => {
    // The one call whose honest work can take two minutes. The composition is
    // `AbortSignal.any`, so a caller's signal can only ever make a request
    // settle sooner — which is why the broker states its deadline rather than
    // passing a signal.
    expect(CHAT_SESSION_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(STATUS_ATTEMPT_TIMEOUT_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
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

  test("the probe is deadlined — a hung one would stop the poll loop for good", async () => {
    // The pane re-arms its timer from the settled promise, so a request that
    // never settles doesn't miss a tick, it ends the polling: "Starting your
    // preview" stays up even after the preview deployed.
    const fetchMock = stubFetch({ "/p-preview/health": () => jsonResponse({ status: "ok" }) });
    await api.agentPageReady("p-preview");
    expect(fetchCall(fetchMock).init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a timed-out probe reads as not-ready, which is what re-arms the poll", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new DOMException("signal timed out", "TimeoutError"))),
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
    // Wait for the CONDITION, not for one macrotask: `sseResponse` happens to
    // pre-enqueue every frame today, so a tick is enough — but any transform
    // added to `api-events.ts` would turn each of these into a comparison
    // against a partially-delivered array. The closed stream reporting down is
    // what says the whole body was read.
    await vi.waitFor(() => expect(down).toHaveBeenCalledOnce());
    expect(seen).toEqual([
      { files: {}, previewStale: true },
      { files: {}, previewStale: false, previewVersion: "abc" },
    ]);
  });

  test("a frame that is not the shape this build expects is DROPPED, stream intact", async () => {
    // The three casts this dispatch used to make (`JSON.parse(frame.data) as
    // ProjectData`) asserted a shape nothing had checked, so a malformed or
    // wrong-shaped payload reached the panes as one — `files` undefined, and a
    // Code pane that renders nothing. Guarded, the frame is ignored and the
    // NEXT one still arrives, which is what a stream of whole snapshots can do
    // and a torn-down connection cannot.
    stubFetch(() =>
      sseResponse([
        // Unparsable JSON: the SDK's reader yields `data: undefined`.
        "event: project\ndata: {oops\n\n",
        // Parsable, wrong shape — `files` is not a record of strings.
        'event: project\ndata: {"files":"nope"}\n\n',
        'event: project\ndata: {"files":{},"previewStale":true}\n\n',
      ]),
    );
    const seen: unknown[] = [];
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: (d) => seen.push(d), onDown: down });
    await vi.waitFor(() => expect(down).toHaveBeenCalledOnce());
    expect(seen).toEqual([{ files: {}, previewStale: true }]);
  });

  test("a chat frame that is not a message list is dropped", async () => {
    stubFetch(() =>
      sseResponse([
        // A message with no `id` — the key React would render it under.
        'event: chat\ndata: [{"role":"user","parts":[]}]\n\n',
        'event: chat\ndata: [{"id":"m1","role":"user","parts":[]}]\n\n',
      ]),
    );
    const chats: unknown[] = [];
    const down = vi.fn();
    api.watchProject("k", "proj", {
      onData: () => undefined,
      onChat: (m) => chats.push(m),
      onDown: down,
    });
    await vi.waitFor(() => expect(down).toHaveBeenCalledOnce());
    expect(chats).toEqual([[{ id: "m1", role: "user", parts: [] }]]);
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
    await vi.waitFor(() => expect(chats).toHaveLength(1));
    expect(chats).toEqual([[{ id: "m1", role: "user", parts: [] }]]);
  });

  test("a non-OK response reports down as a transport failure", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 503));
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: () => undefined, onDown: down });
    await vi.waitFor(() => expect(down).toHaveBeenCalledExactlyOnceWith("transport"));
  });

  test.for([401, 403])("a %i reports down as an AUTH failure, not transport", async (status) => {
    // The distinction the caller acts on: retrying a rejected bearer can only
    // loop. One backgrounded tab whose session token expired (supabase-js
    // pauses its refresh ticker on hidden tabs) resubscribed every 3s for
    // three hours — 4,346 401s, each costing a Supabase token verification.
    stubFetch(() => jsonResponse({ error: "unauthorized" }, status));
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: () => undefined, onDown: down });
    await vi.waitFor(() => expect(down).toHaveBeenCalledExactlyOnceWith("auth"));
  });

  test("onOpen fires only when the server accepted the stream", async () => {
    // It is the caller's backoff reset, so it must not fire for a rejection.
    stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const open = vi.fn();
    const down = vi.fn();
    api.watchProject("k", "proj", { onData: () => undefined, onOpen: open, onDown: down });
    // The rejection reaching `onDown` is the sync point — the negative below
    // is only meaningful once the attempt has actually settled.
    await vi.waitFor(() => expect(down).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();

    stubFetch(() => sseResponse(['event: project\ndata: {"files":{}}\n\n']));
    api.watchProject("k", "proj", {
      onData: () => undefined,
      onOpen: open,
      onDown: () => undefined,
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  });

  test("aborting via the returned unsubscribe does NOT report down", async () => {
    // A never-ending stream: unsubscribe is the only way out. Nothing is
    // delivered, so the open request is the only condition to wait on; the
    // `settle()` after `stop()` bounds the abort's own propagation, which is
    // the one thing here a condition cannot express (the assertion is that
    // nothing happens).
    const fetchMock = stubFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const down = vi.fn();
    const stop = api.watchProject("k", "proj", { onData: () => undefined, onDown: down });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
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
    // The closed stream reporting down is what says every frame was read.
    await vi.waitFor(() => expect(down).toHaveBeenCalledOnce());
    expect(lists).toEqual([["a"], ["a", "b"]]);
  });

  test("a list that is not names is dropped", async () => {
    // Fully checkable, unlike the two shapes above — so it is fully checked.
    stubFetch(() =>
      sseResponse(["event: projects\ndata: [1,2]\n\n", 'event: projects\ndata: ["a"]\n\n']),
    );
    const lists: string[][] = [];
    const down = vi.fn();
    api.watchProjects("k", { onData: (names) => lists.push(names), onDown: down });
    await vi.waitFor(() => expect(down).toHaveBeenCalledOnce());
    expect(lists).toEqual([["a"]]);
  });
});
