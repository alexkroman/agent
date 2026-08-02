// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, parseSecrets } from "./api.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(makeResponse: () => Response) {
  // A Response body is single-use, so mint a fresh one per call.
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeResponse()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
