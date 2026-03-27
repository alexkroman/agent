import { describe, expect, test, vi } from "vitest";

// Stable mock references
const mockQueryFn = vi.fn();
const mockExecaFn = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
}));

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExecaFn(...args),
}));

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    pull: vi.fn().mockResolvedValue(undefined),
    clone: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ staged: ["agent.ts"] }),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn().mockReturnValue(true), mkdirSync: vi.fn() },
  };
});

import type { Config } from "./_config.ts";
import { createMessageHandler } from "./_handler.ts";

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    anthropicApiKey: "sk-ant-test",
    assemblyaiApiKey: "test-key",
    serverUrl: "https://aai-agent.fly.dev",
    examplesRepoPath: "/tmp/test-examples",
    ...overrides,
  };
}

function makeEvent(overrides?: Record<string, unknown>) {
  return {
    text: "make a trivia bot",
    channel: "C123",
    channel_type: "im",
    ts: "1234567890.000001",
    ...overrides,
  };
}

function makeClient() {
  const updates: string[] = [];
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "status-msg-ts" }),
        update: vi.fn().mockImplementation(async ({ text }: { text: string }) => {
          updates.push(text);
        }),
      },
    },
    updates,
  };
}

function setupMocks() {
  mockQueryFn.mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "sess-123" };
    },
  });

  mockExecaFn
    .mockResolvedValueOnce({ stdout: "", stderr: "" }) // init
    .mockResolvedValueOnce({ stdout: "Ready: https://aai-agent.fly.dev/happy-dragon", stderr: "" }); // deploy
}

/** Wait for the fire-and-forget handler to finish by polling for a final status update. */
async function waitForUpdates(updates: string[], minCount: number) {
  await vi.waitFor(() => {
    if (updates.length < minCount)
      throw new Error(`Expected ${minCount} updates, got ${updates.length}`);
  });
}

describe("createMessageHandler", () => {
  test("ignores bot messages", () => {
    const handler = createMessageHandler(makeConfig());
    const { client } = makeClient();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ bot_id: "B123" }), client } as any);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("ignores message subtypes", () => {
    const handler = createMessageHandler(makeConfig());
    const { client } = makeClient();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ subtype: "message_changed" }), client } as any);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("ignores messages without text", () => {
    const handler = createMessageHandler(makeConfig());
    const { client } = makeClient();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ text: undefined }), client } as any);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("full flow: scaffold, generate, deploy, git push", async () => {
    setupMocks();
    const handler = createMessageHandler(makeConfig());
    const { client, updates } = makeClient();

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent(), client } as any);

    await waitForUpdates(updates, 4);

    expect(updates).toContain("Scaffolding project...");
    expect(updates).toContain("Generating agent code...");
    expect(updates).toContain("Deploying...");
    expect(updates).toContain("Saving to GitHub...");

    const finalUpdate = updates.at(-1);
    expect(finalUpdate).toContain("https://aai-agent.fly.dev/happy-dragon");
    expect(finalUpdate).toContain("https://github.com/alexkroman/examples/tree/main/");
  });

  test("follow-up in same thread resumes session and skips init", async () => {
    setupMocks();
    const handler = createMessageHandler(makeConfig());
    const { client, updates } = makeClient();

    // First message
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ ts: "thread-follow-up" }), client } as any);
    await waitForUpdates(updates, 4);

    // Reset for second call
    mockExecaFn.mockReset();
    mockExecaFn.mockResolvedValue({
      stdout: "Ready: https://aai-agent.fly.dev/happy-dragon",
      stderr: "",
    });
    mockQueryFn.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess-456" };
      },
    });

    const { client: client2, updates: updates2 } = makeClient();

    // Second message in same thread
    handler({
      event: makeEvent({ thread_ts: "thread-follow-up", ts: "reply-ts", text: "add scoring" }),
      client: client2,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    await waitForUpdates(updates2, 3);

    // Should NOT have called init
    const hasInit = mockExecaFn.mock.calls.some((c) => {
      const args = c[1] as string[] | undefined;
      return args?.includes("init");
    });
    expect(hasInit).toBe(false);

    // Should have resumed with session from first message
    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: "sess-123" }),
      }),
    );

    // Should NOT include "Scaffolding project..."
    expect(updates2).not.toContain("Scaffolding project...");
  });

  test("shows error in status when deploy fails", async () => {
    mockQueryFn.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess-err" };
      },
    });
    mockExecaFn
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("Deploy failed: 401 Unauthorized"));

    const handler = createMessageHandler(makeConfig());
    const { client, updates } = makeClient();

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ ts: "error-thread" }), client } as any);

    await waitForUpdates(updates, 2);

    const finalUpdate = updates.at(-1);
    expect(finalUpdate).toContain("Failed:");
    expect(finalUpdate).toContain("401 Unauthorized");
  });

  test("in channels, ignores messages without @mention or known thread", () => {
    setupMocks();
    const handler = createMessageHandler(makeConfig());
    const { client } = makeClient();

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ channel_type: "channel", ts: "random-msg" }), client } as any);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("in channels, responds to @mention", async () => {
    setupMocks();
    const handler = createMessageHandler(makeConfig());
    const { client, updates } = makeClient();

    handler({
      event: makeEvent({
        channel_type: "channel",
        text: "<@U123> make a trivia bot",
        ts: "mention-ts",
      }),
      client,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    await waitForUpdates(updates, 4);

    const finalUpdate = updates.at(-1);
    expect(finalUpdate).toContain("https://aai-agent.fly.dev/happy-dragon");
  });

  test("strips @mention from prompt before passing to Claude", async () => {
    setupMocks();
    const handler = createMessageHandler(makeConfig());
    const { client, updates } = makeClient();

    handler({
      event: makeEvent({
        channel_type: "channel",
        text: "<@U123> make a trivia bot",
        ts: "strip-ts",
      }),
      client,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    await waitForUpdates(updates, 4);

    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "make a trivia bot" }),
    );
  });

  test("shows error when claude fails", async () => {
    mockQueryFn.mockReturnValue({
      // biome-ignore lint/correctness/useYield: throws before yielding to simulate error
      async *[Symbol.asyncIterator]() {
        throw new Error("API rate limit exceeded");
      },
    });
    mockExecaFn.mockResolvedValue({ stdout: "", stderr: "" });

    const handler = createMessageHandler(makeConfig());
    const { client, updates } = makeClient();

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    handler({ event: makeEvent({ ts: "claude-error-thread" }), client } as any);

    await waitForUpdates(updates, 2);

    const finalUpdate = updates.at(-1);
    expect(finalUpdate).toContain("Failed:");
    expect(finalUpdate).toContain("rate limit");
  });
});
