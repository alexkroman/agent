// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { ASSEMBLYAI_DOCS_MCP_URL, mcpUrls, mergeServerTools, openMcpTools } from "./studio-mcp.ts";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mcpUrls", () => {
  test("defaults to the AssemblyAI docs server", () => {
    expect(mcpUrls(env({}))).toEqual([ASSEMBLYAI_DOCS_MCP_URL]);
  });

  test("STUDIO_MCP_URLS replaces the default", () => {
    expect(mcpUrls(env({ STUDIO_MCP_URLS: "https://a/mcp, https://b/mcp" }))).toEqual([
      "https://a/mcp",
      "https://b/mcp",
    ]);
  });

  test("an empty STUDIO_MCP_URLS disables MCP", () => {
    // Distinct from unset: an operator must be able to turn this off.
    expect(mcpUrls(env({ STUDIO_MCP_URLS: "" }))).toEqual([]);
  });
});

describe("openMcpTools", () => {
  test("disabled config connects to nothing", async () => {
    const session = await openMcpTools(env({ STUDIO_MCP_URLS: "" }));
    expect(session.tools).toEqual({});
    await expect(session.close()).resolves.toBeUndefined();
  });

  test("an unreachable server degrades to no tools instead of throwing", async () => {
    // The whole point: a docs server being down must cost a lookup, not the
    // user's turn. 127.0.0.1:1 refuses immediately.
    vi.spyOn(console, "warn").mockImplementation(() => {
      /* the warning is the assertion below, not test output */
    });
    const session = await openMcpTools(env({ STUDIO_MCP_URLS: "http://127.0.0.1:1/mcp" }));
    expect(session.tools).toEqual({});
    expect(console.warn).toHaveBeenCalled();
    await session.close();
  }, 20_000);

  test("close is idempotent", async () => {
    const session = await openMcpTools(env({ STUDIO_MCP_URLS: "" }));
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("mergeServerTools", () => {
  // Stand-ins: only the keys matter to the merge rule.
  const fake = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, { description: n }])) as never;

  test("drops side-effecting tools the docs server advertises", () => {
    // submit_feedback posts to AssemblyAI; a coding turn must not be able to
    // speak for the user, and read-only lookup is why MCP is wired up at all.
    const merged = mergeServerTools([fake("search_assembly_ai", "submit_feedback")]);
    expect(Object.keys(merged)).toEqual(["search_assembly_ai"]);
  });

  test("the first server wins a name clash", () => {
    const merged = mergeServerTools([fake("search"), fake("search", "other")]);
    expect(Object.keys(merged).sort()).toEqual(["other", "search"]);
    expect((merged as Record<string, { description: string }>).search?.description).toBe("search");
  });
});
