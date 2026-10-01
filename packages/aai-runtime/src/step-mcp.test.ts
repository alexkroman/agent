// Copyright 2026 the AAI authors. MIT license.
/**
 * The connector behind `stepMcp`, over the `openSession` seam — no socket.
 *
 * Pins the two things this caller adds to the shared core: the step's
 * `clientId` reaches every resolver, and an unavailable server REJECTS (after
 * closing what did connect) instead of degrading.
 */

import type { McpServers } from "@alexkroman1/aai";
import { stepMcp } from "@alexkroman1/aai/experimental";
import { publishStepMcp } from "@alexkroman1/aai/host-internal";
import { createToolContext } from "@alexkroman1/aai/testing";
import { tool as aiTool, jsonSchema } from "ai";
import { afterEach, describe, expect, test } from "vitest";
import { silentLogger } from "./_logger-test-utils.ts";
import type { McpSession, ResolvedMcpServer } from "./mcp/index.ts";
import { createStepMcp } from "./step-mcp.ts";

function fakeSession(): McpSession & { closed: number } {
  const session = {
    closed: 0,
    tools: async () => ({
      search: aiTool({
        description: "Search",
        inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }),
        execute: async (args: unknown) => ({
          content: [{ type: "text", text: `found ${JSON.stringify(args)}` }],
        }),
      }),
    }),
    close: async () => {
      session.closed += 1;
    },
  };
  return session;
}

const APPS: McpServers = {
  apps: {
    url: ({ clientId }) => `https://mcp.example.com/users/${clientId}`,
    headers: ({ env }) => ({ "x-api-key": env.APPS_KEY ?? "" }),
  },
};

afterEach(() => publishStepMcp(undefined));

describe("stepMcp", () => {
  test("resolves for the step's client and hands back ordinary, callable ToolDefs", async () => {
    const seen: ResolvedMcpServer[] = [];
    publishStepMcp(
      createStepMcp({
        env: { APPS_KEY: "k" },
        logger: silentLogger,
        openSession: async (server) => {
          seen.push(server);
          return fakeSession();
        },
      }),
    );
    const mcp = await stepMcp(APPS, { clientId: "speaker-1" });
    expect(seen).toEqual([
      {
        key: "apps",
        url: "https://mcp.example.com/users/speaker-1",
        headers: { "x-api-key": "k" },
      },
    ]);
    expect(Object.keys(mcp.tools)).toEqual(["mcp_apps_search"]);
    expect(mcp.servers).toEqual([{ key: "apps", tools: ["mcp_apps_search"] }]);
    const search = mcp.tools.mcp_apps_search;
    const result = await search?.execute({ q: "x" }, createToolContext());
    expect(result).toBe('found {"q":"x"}');
    await mcp.close();
  });

  test("an unavailable server REJECTS, naming it, after closing what did connect", async () => {
    const opened: ReturnType<typeof fakeSession>[] = [];
    publishStepMcp(
      createStepMcp({
        logger: silentLogger,
        openSession: async (server) => {
          if (server.key === "down") throw new Error("connection refused");
          const session = fakeSession();
          opened.push(session);
          return session;
        },
      }),
    );
    await expect(
      stepMcp(
        { up: { url: "https://up.example/mcp" }, down: { url: "https://down.example/mcp" } },
        { clientId: "speaker-1" },
      ),
    ).rejects.toThrow('"down" (connection refused)');
    expect(opened.map((s) => s.closed)).toEqual([1]);
  });

  test("unpublished, it rejects rather than answering an empty tool list", async () => {
    await expect(stepMcp(APPS)).rejects.toThrow("no MCP connector is published");
  });
});
