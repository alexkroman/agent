// Copyright 2026 the AAI authors. MIT license.
// The connected half of studio-mcp: what happens when createMCPClient
// succeeds. Separate file from studio-mcp.test.ts because the client module
// is mocked here, while that file exercises the real (failing) transport.

import { afterEach, describe, expect, test, vi } from "vitest";

const clients: { tools: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
/** Per-URL behavior for the next openMcpTools call. */
const behavior = new Map<string, { tools?: Record<string, unknown>; toolsError?: Error }>();

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async ({ transport }: { transport: { url: string } }) => {
    const spec = behavior.get(transport.url) ?? {};
    const client = {
      tools: vi.fn(async () => {
        if (spec.toolsError) throw spec.toolsError;
        return spec.tools ?? {};
      }),
      close: vi.fn(async () => undefined),
    };
    clients.push(client);
    return client;
  }),
}));

import { openMcpTools } from "./studio-mcp.ts";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

afterEach(() => {
  clients.length = 0;
  behavior.clear();
  vi.restoreAllMocks();
});

describe("openMcpTools (connected)", () => {
  test("merges tools from a reachable server and closes it exactly once", async () => {
    behavior.set("https://docs/mcp", {
      tools: { search_docs: { description: "d" }, submit_feedback: { description: "f" } },
    });
    const session = await openMcpTools(env({ STUDIO_MCP_URLS: "https://docs/mcp" }));
    // The denied side-effecting tool is dropped even on the happy path.
    expect(Object.keys(session.tools)).toEqual(["search_docs"]);
    await session.close();
    await session.close(); // idempotent — the client must not be closed twice
    expect(clients[0]?.close).toHaveBeenCalledTimes(1);
  });

  test("a server whose tool listing fails is closed and skipped, others survive", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      /* the warning is asserted via the surviving tool set */
    });
    behavior.set("https://bad/mcp", { toolsError: new Error("listing broke") });
    behavior.set("https://good/mcp", { tools: { search_docs: { description: "d" } } });
    const session = await openMcpTools(
      env({ STUDIO_MCP_URLS: "https://bad/mcp, https://good/mcp" }),
    );
    expect(Object.keys(session.tools)).toEqual(["search_docs"]);
    // The failed client was cleaned up at connect time, not leaked.
    expect(clients[0]?.close).toHaveBeenCalledTimes(1);
    await session.close();
  });
});
