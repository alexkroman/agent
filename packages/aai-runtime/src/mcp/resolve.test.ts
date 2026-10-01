// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolving one declared server for one connection, and the `allowedTools`
 * scope. Pure: no opener, no socket. The end-to-end paths through
 * `withMcpTools` and `stepMcp` are in `tools.test.ts` and
 * `../step-mcp.test.ts`.
 */

import type { McpServerConfig } from "@alexkroman1/aai";
import { tool as aiTool, jsonSchema } from "ai";
import { describe, expect, test } from "vitest";
import { makeLogger } from "../_test-utils.ts";
import { allowTools, displayUrl, resolveServer } from "./resolve.ts";

const signal = new AbortController().signal;

describe("resolveServer", () => {
  test("a literal server resolves to itself, with no headers invented", async () => {
    await expect(
      resolveServer(
        "docs",
        { url: "https://a.example/mcp" },
        { env: {}, clientId: undefined, signal },
      ),
    ).resolves.toEqual({ server: { key: "docs", url: "https://a.example/mcp" } });
  });

  test("resolvers get the clientId, env and signal, once each", async () => {
    const seen: unknown[] = [];
    const config: McpServerConfig = {
      url: (ctx) => {
        seen.push(ctx);
        return `https://a.example/u/${ctx.clientId}`;
      },
      headers: async (ctx) => ({ "x-api-key": ctx.env.KEY ?? "" }),
      tokenEnv: "TOKEN",
    };
    const resolved = await resolveServer("apps", config, {
      env: { KEY: "k", TOKEN: "t" },
      clientId: "c-1",
      signal,
    });
    expect(resolved).toEqual({
      server: {
        key: "apps",
        url: "https://a.example/u/c-1",
        headers: { "x-api-key": "k" },
        token: "t",
      },
    });
    expect(seen).toEqual([{ clientId: "c-1", env: { KEY: "k", TOKEN: "t" }, signal }]);
  });

  test.each([["file:///tmp/x"], ["not a url"], ["stdio:///bin/mcp"]])(
    "a resolved %s is refused like a literal would be",
    async (url) => {
      const resolved = await resolveServer(
        "apps",
        { url: () => url },
        { env: {}, clientId: undefined, signal },
      );
      expect(resolved).toEqual({ unavailable: expect.stringContaining("http(s)") });
    },
  );

  test("a missing tokenEnv fails the server by name", async () => {
    const resolved = await resolveServer(
      "docs",
      { url: "https://a.example/mcp", tokenEnv: "DOCS_TOKEN" },
      { env: {}, clientId: undefined, signal },
    );
    expect(resolved).toEqual({ unavailable: expect.stringContaining("DOCS_TOKEN is not set") });
  });
});

describe("displayUrl", () => {
  test("a literal is shown as written; a resolved one by its origin only", () => {
    expect(displayUrl({ url: "https://a.example/mcp" })).toBe("https://a.example/mcp");
    const dynamic: McpServerConfig = { url: () => "" };
    expect(displayUrl(dynamic, "https://a.example/session/secret-id/mcp")).toBe(
      "https://a.example",
    );
    expect(displayUrl(dynamic)).toBe("(resolved per connection)");
  });
});

describe("allowTools", () => {
  const tool = aiTool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "" });

  test("no list keeps everything", () => {
    const tools = { a: tool, b: tool };
    expect(allowTools("s", tools, undefined, undefined)).toBe(tools);
  });

  test("a list keeps only its names, and warns about one the server lacks", () => {
    const logger = makeLogger();
    expect(Object.keys(allowTools("s", { a: tool, b: tool }, ["b", "zz"], logger))).toEqual(["b"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"zz"'));
  });
});
