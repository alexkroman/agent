// Copyright 2026 the AAI authors. MIT license.
/**
 * The real `@ai-sdk/mcp` client, over a fake `fetch`.
 *
 * `mcp-tools.test.ts` drives the `openSession` SEAM, which says nothing about
 * whether the transport underneath it works. This file goes the other way: the
 * client and its streamable-HTTP transport here are the shipped ones, speaking
 * real JSON-RPC, and the only substitution is the `fetch` they are handed —
 * which is also the thing most worth asserting, since a transport that quietly
 * used its own `fetch` would be egress this repo does not screen.
 *
 * The fake server answers `application/json` to every POST and `405` to the
 * standalone `GET`, which is the spec's "this server offers no SSE stream" and
 * the shape a JSON-only MCP server really has.
 */

import { describe, expect, test } from "vitest";
import { fakeFetch } from "./_test-utils.ts";
import { openMcpSession, toCallResult } from "./mcp-connect.ts";

const ENDPOINT = "https://mcp.example.com/mcp";

type JsonRpc = { jsonrpc: "2.0"; id?: unknown; method?: string; params?: Record<string, unknown> };

type ServeOptions = {
  /** Entries for `tools/list`. */
  tools?: readonly unknown[];
  /** What `tools/call` answers, given the request params. */
  call?: (params: Record<string, unknown>) => unknown;
  /** Every POST, in order: the headers it carried and its parsed body. */
  posts?: { headers: Headers; body: JsonRpc }[];
  /** Every request method+url, in order. */
  requests?: string[];
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: unknown, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32_601, message } });
}

/** A minimal streamable-HTTP MCP server, in one `fetch`. */
function mcpFetch(options: ServeOptions = {}): typeof globalThis.fetch {
  return fakeFetch(async (url, init) => {
    options.requests?.push(`${init.method ?? "GET"} ${String(url)}`);
    // The standalone SSE stream is optional; 405 is how a server declines it.
    if ((init.method ?? "GET") === "GET") return new Response(null, { status: 405 });

    const body: JsonRpc = JSON.parse(String(init.body));
    options.posts?.push({ headers: new Headers(init.headers), body });
    // A notification carries no id and expects no reply.
    if (body.id === undefined) return new Response(null, { status: 202 });

    if (body.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          // Echoed, so this fake stays valid as the SDK's supported list moves.
          protocolVersion: body.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-docs", version: "0" },
        },
      });
    }
    if (body.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: options.tools ?? [] } });
    }
    if (body.method === "tools/call") {
      const result = options.call?.(body.params ?? {}) ?? { content: [] };
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result });
    }
    // Anything else — `server/discover`, say, which the client probes with
    // before falling back to `initialize` — is refused the way a server that
    // does not implement it refuses.
    return rpcError(body.id, `no such method: ${String(body.method)}`);
  });
}

const SEARCH_ENTRY = {
  name: "search",
  description: "Search the docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("a real handshake over the injected fetch", () => {
  test("lists tools, and every request goes to the fetch we supplied", async () => {
    const requests: string[] = [];
    const session = await openMcpSession(
      { key: "docs", url: ENDPOINT },
      { fetch: mcpFetch({ tools: [SEARCH_ENTRY], requests }) },
    );
    try {
      const tools = await session.tools();
      expect(Object.keys(tools)).toEqual(["search"]);
      expect(tools.search?.description).toBe("Search the docs");
    } finally {
      await session.close();
    }
    expect(requests).toContain(`POST ${ENDPOINT}`);
    expect(requests.every((line) => line.endsWith(ENDPOINT))).toBe(true);
  });

  test("a declared token becomes a bearer header on every request", async () => {
    const posts: { headers: Headers; body: JsonRpc }[] = [];
    const session = await openMcpSession(
      { key: "docs", url: ENDPOINT, token: "sekret" },
      { fetch: mcpFetch({ tools: [], posts }) },
    );
    await session.tools();
    await session.close();
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(post.headers.get("authorization")).toBe("Bearer sekret");
    }
  });

  test("no token means no authorization header — never an empty one", async () => {
    const posts: { headers: Headers; body: JsonRpc }[] = [];
    const session = await openMcpSession(
      { key: "docs", url: ENDPOINT },
      { fetch: mcpFetch({ tools: [], posts }) },
    );
    await session.close();
    expect(posts[0]?.headers.get("authorization")).toBeNull();
  });

  test("a discovered tool's execute sends the remote name and arguments", async () => {
    const seen: Record<string, unknown>[] = [];
    const session = await openMcpSession(
      { key: "docs", url: ENDPOINT },
      {
        fetch: mcpFetch({
          tools: [SEARCH_ENTRY],
          call: (params) => {
            seen.push(params);
            return { content: [{ type: "text", text: "two hits" }] };
          },
        }),
      },
    );
    try {
      const call = (await session.tools()).search?.execute;
      expect(call).toBeTypeOf("function");
      const result = await call?.(
        { query: "budgets" },
        { toolCallId: "t1", messages: [], context: {} },
      );
      expect(toCallResult(result)).toEqual({ isError: false, text: "two hits", otherParts: [] });
    } finally {
      await session.close();
    }
    expect(seen).toEqual([{ name: "search", arguments: { query: "budgets" } }]);
  });
});

describe("a server that does not answer", () => {
  test("the connect is bounded and the failure names the server", async () => {
    // Never settles — the wedged-server case, which is the one a plain `await`
    // would turn into a session that never starts.
    const hung = fakeFetch(() => new Promise<Response>(() => undefined));
    await expect(
      openMcpSession({ key: "docs", url: ENDPOINT }, { fetch: hung, connectTimeoutMs: 20 }),
    ).rejects.toThrow(/"docs" did not complete its handshake within 20ms/);
  });

  test("a refused connection rejects with the transport's own reason", async () => {
    const refused = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(
      openMcpSession({ key: "docs", url: ENDPOINT }, { fetch: refused, connectTimeoutMs: 500 }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  test("an HTTP error on the handshake rejects rather than yielding a dead session", async () => {
    const unauthorized = fakeFetch(async () => new Response("nope", { status: 401 }));
    await expect(
      openMcpSession(
        { key: "docs", url: ENDPOINT },
        { fetch: unauthorized, connectTimeoutMs: 500 },
      ),
    ).rejects.toThrow();
  });
});

describe("toCallResult", () => {
  test("a non-object reply is an empty, non-error result rather than a throw", () => {
    expect(toCallResult("nonsense")).toEqual({ isError: false, text: "", otherParts: [] });
  });

  test("text parts are joined and every other part is named", () => {
    expect(
      toCallResult({
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "…", mimeType: "image/png" },
          { type: "text", text: "two" },
          "not a part",
        ],
      }),
    ).toEqual({ isError: false, text: "one\ntwo", otherParts: ["image"] });
  });

  test("structuredContent and isError are both carried through", () => {
    expect(toCallResult({ content: [], isError: true, structuredContent: { code: 429 } })).toEqual({
      isError: true,
      text: "",
      structured: { code: 429 },
      otherParts: [],
    });
  });
});
