// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { type AgentConfig, AgentConfigSchema, toAgentConfig } from "./agent-config.ts";
import { agent } from "./define.ts";
import {
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  type McpServers,
  mcpToolName,
} from "./mcp-config.ts";

const VALID: AgentConfig = {
  name: "Docs",
  systemPrompt: "Be helpful",
  greeting: "Hello",
};

describe("mcpToolName", () => {
  test("namespaces with the prefix and the server key", () => {
    expect(mcpToolName("docs", "search")).toBe("mcp_docs_search");
    expect(mcpToolName("docs", "search").startsWith(MCP_TOOL_PREFIX)).toBe(true);
  });

  test.each([
    ["camelCase", "getWeather", "mcp_docs_getweather"],
    ["a hyphen", "search-docs", "mcp_docs_search_docs"],
    ["a dot and a slash", "a.b/c", "mcp_docs_a_b_c"],
    ["a run of illegal characters", "a  --  b", "mcp_docs_a_b"],
  ])("normalizes %s, because a server's names are its own", (_label, remote, expected) => {
    expect(mcpToolName("docs", remote)).toBe(expected);
  });

  test("every output is a name a provider accepts", () => {
    const long = mcpToolName("docs", "x".repeat(200));
    expect(long).toHaveLength(MCP_TOOL_NAME_MAX);
    expect(long).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("truncation is what makes a collision possible, which is why the caller dedupes", () => {
    const stem = "y".repeat(80);
    expect(mcpToolName("docs", `${stem}a`)).toBe(mcpToolName("docs", `${stem}b`));
  });
});

describe("MCP_SERVER_KEY_RE", () => {
  test.each(["docs", "d", "internal_wiki", "a1_b2"])("accepts %s", (key) => {
    expect(MCP_SERVER_KEY_RE.test(key)).toBe(true);
  });

  test.each([
    ["", "blank"],
    ["Docs", "an uppercase letter a provider would keep and this SDK would not"],
    ["1docs", "a leading digit"],
    ["my-docs", "a hyphen"],
    ["a".repeat(25), "over the 24-character cap"],
  ])("rejects %s (%s)", (key) => {
    expect(MCP_SERVER_KEY_RE.test(key)).toBe(false);
  });
});

describe("AgentConfigSchema.mcpServers", () => {
  test("accepts a server with a literal URL and a token variable NAME", () => {
    const parsed = AgentConfigSchema.parse({
      ...VALID,
      mcpServers: { docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" } },
    });
    expect(parsed.mcpServers).toEqual({
      docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" },
    });
  });

  test.each([
    ["a key a provider would reject", { "My Docs": { url: "https://a.example/mcp" } }],
    ["a stdio command", { docs: { url: "stdio:///usr/bin/mcp-server" } }],
    ["a file URL", { docs: { url: "file:///tmp/mcp.sock" } }],
    ["a URL that is not one", { docs: { url: "not a url" } }],
    ["an inline token", { docs: { url: "https://a.example/mcp", token: "sekret" } }],
    ["a misspelled field", { docs: { url: "https://a.example/mcp", tokenENV: "T" } }],
    [
      "a token variable that is not a variable name",
      { docs: { url: "https://a.example/mcp", tokenEnv: "A B" } },
    ],
  ])("rejects %s", (_label, mcpServers) => {
    expect(AgentConfigSchema.safeParse({ ...VALID, mcpServers }).success).toBe(false);
  });

  test("accepts a reviewed tool baseline", () => {
    const parsed = AgentConfigSchema.parse({
      ...VALID,
      mcpServers: {
        docs: { url: "https://mcp.example.com/mcp", pinnedTools: { search: "sha256-abc" } },
      },
    });
    expect(parsed.mcpServers?.docs?.pinnedTools).toEqual({ search: "sha256-abc" });
  });

  test.each([
    ["a baseline that is not a map", { docs: { url: "https://a.example/mcp", pinnedTools: [] } }],
    [
      "a baseline entry with no digest",
      { docs: { url: "https://a.example/mcp", pinnedTools: { search: "" } } },
    ],
  ])("rejects %s", (_label, mcpServers) => {
    expect(AgentConfigSchema.safeParse({ ...VALID, mcpServers }).success).toBe(false);
  });

  test("the declaration survives the CLI → server → runtime boundary", () => {
    const config = toAgentConfig({
      ...VALID,
      mcpServers: { docs: { url: "https://mcp.example.com/mcp" } },
    });
    expect(config.mcpServers).toEqual({ docs: { url: "https://mcp.example.com/mcp" } });
    // And the serialized config really is JSON, which is the claim that makes
    // it safe to carry into a guest sandbox.
    expect(JSON.parse(JSON.stringify(config)).mcpServers).toEqual(config.mcpServers);
  });

  test("what an author writes on the agent is what the wire schema accepts", () => {
    const declared = agent({
      name: "Docs",
      mcpServers: { docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" } },
      requiredEnv: ["DOCS_MCP_TOKEN"],
    });
    expect(declared.mcpServers).toEqual({
      docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" },
    });
    expectTypeOf<McpServers | undefined>().toExtend<AgentConfig["mcpServers"]>();
  });
});
