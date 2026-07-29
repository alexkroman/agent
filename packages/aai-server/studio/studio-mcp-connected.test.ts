// Copyright 2026 the AAI authors. MIT license.
// The connected half of studio-mcp: what happens when createMCPClient
// succeeds. Separate file from studio-mcp.test.ts because the client module
// is mocked here, while that file exercises the real (failing) transport.

import { afterEach, describe, expect, test, vi } from "vitest";

type FakeClient = {
  listTools: ReturnType<typeof vi.fn>;
  toolsFromDefinitions: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
const clients: FakeClient[] = [];
/** Per-URL behavior for the next openMcpTools call. */
const behavior = new Map<
  string,
  { tools?: Record<string, unknown>; toolsError?: Error; connectDelayMs?: number }
>();

type FakeDefinitions = { tools: { name: string; description: string | undefined }[] };

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async ({ transport }: { transport: { url: string } }) => {
    const spec = behavior.get(transport.url) ?? {};
    if (spec.connectDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, spec.connectDelayMs));
    }
    const client: FakeClient = {
      // The wire shape: `tools/list` returns definitions...
      listTools: vi.fn(async (): Promise<FakeDefinitions> => {
        if (spec.toolsError) throw spec.toolsError;
        return {
          tools: Object.entries(spec.tools ?? {}).map(([name, def]) => ({
            name,
            description: (def as { description?: string }).description,
          })),
        };
      }),
      // ...and tool objects are built client-side, bound to this client.
      toolsFromDefinitions: vi.fn((definitions: FakeDefinitions) =>
        Object.fromEntries(definitions.tools.map((t) => [t.name, { description: t.description }])),
      ),
      close: vi.fn(async () => undefined),
    };
    clients.push(client);
    return client;
  }),
}));

import { clearMcpToolListCache, openMcpTools } from "./studio-mcp.ts";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

afterEach(() => {
  clients.length = 0;
  behavior.clear();
  clearMcpToolListCache();
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

  test("a connect that resolves after the timeout is closed, not leaked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Slower than CONNECT_TIMEOUT_MS (2s): the turn gives up on MCP, but the
    // abandoned connect still resolves — its client must be closed rather
    // than leaking one HTTP client per turn while the docs server is slow.
    behavior.set("https://slow/mcp", {
      connectDelayMs: 2300,
      tools: { search_docs: { description: "d" } },
    });
    const session = await openMcpTools(env({ STUDIO_MCP_URLS: "https://slow/mcp" }));
    expect(session.tools).toEqual({});
    await vi.waitFor(
      () => {
        expect(clients[0]?.close).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    await session.close();
  }, 10_000);

  test("the tool listing is cached across turns; tool objects are rebuilt per turn", async () => {
    behavior.set("https://docs/mcp", { tools: { search_docs: { description: "d" } } });
    const mcpEnv = env({ STUDIO_MCP_URLS: "https://docs/mcp" });

    const first = await openMcpTools(mcpEnv);
    await first.close();
    const second = await openMcpTools(mcpEnv);
    await second.close();

    // Two turns, two clients — but only the first paid the tools/list round
    // trip. The second turn rebuilt tool objects on its own (open) client
    // from the cached definitions, because a tool's execute is bound to the
    // client it came from and the first turn's client is closed.
    expect(clients).toHaveLength(2);
    expect(clients[0]?.listTools).toHaveBeenCalledTimes(1);
    expect(clients[1]?.listTools).not.toHaveBeenCalled();
    expect(clients[1]?.toolsFromDefinitions).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.tools)).toEqual(["search_docs"]);
  });

  test("a failed listing is not cached — the next turn retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    behavior.set("https://docs/mcp", { toolsError: new Error("down") });
    const mcpEnv = env({ STUDIO_MCP_URLS: "https://docs/mcp" });
    const first = await openMcpTools(mcpEnv);
    expect(first.tools).toEqual({});

    behavior.set("https://docs/mcp", { tools: { search_docs: { description: "d" } } });
    const second = await openMcpTools(mcpEnv);
    expect(Object.keys(second.tools)).toEqual(["search_docs"]);
    await second.close();
  });

  test("clearing the cache forces a fresh listing", async () => {
    behavior.set("https://docs/mcp", { tools: { search_docs: { description: "d" } } });
    const mcpEnv = env({ STUDIO_MCP_URLS: "https://docs/mcp" });
    await (await openMcpTools(mcpEnv)).close();
    clearMcpToolListCache();
    await (await openMcpTools(mcpEnv)).close();
    expect(clients[1]?.listTools).toHaveBeenCalledTimes(1);
  });

  test("a cached listing expires after its TTL", async () => {
    vi.useFakeTimers();
    try {
      behavior.set("https://docs/mcp", { tools: { search_docs: { description: "d" } } });
      const mcpEnv = env({ STUDIO_MCP_URLS: "https://docs/mcp" });
      await (await openMcpTools(mcpEnv)).close();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await (await openMcpTools(mcpEnv)).close();
      expect(clients[1]?.listTools).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
