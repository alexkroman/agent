import { describe, expect, test, vi } from "vitest";

const mockQueryFn = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
}));

import { generateCode } from "./_claude.ts";

function mockMessages(messages: Record<string, unknown>[]) {
  mockQueryFn.mockReturnValue({
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) yield msg;
    },
  });
}

describe("generateCode", () => {
  test("passes prompt and cwd to query", async () => {
    mockMessages([{ type: "system", subtype: "init", session_id: "sess-1" }]);

    await generateCode({ prompt: "make a trivia bot", workDir: "/tmp/app" });

    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make a trivia bot",
        options: expect.objectContaining({
          cwd: "/tmp/app",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  test("captures session ID from init message", async () => {
    mockMessages([
      { type: "system", subtype: "init", session_id: "sess-abc" },
      { type: "text", text: "Done" },
    ]);

    const result = await generateCode({ prompt: "test", workDir: "/tmp/app" });
    expect(result.sessionId).toBe("sess-abc");
  });

  test("passes resume option when sessionId provided", async () => {
    mockMessages([{ type: "system", subtype: "init", session_id: "sess-2" }]);

    await generateCode({ prompt: "add scoring", workDir: "/tmp/app", sessionId: "sess-1" });

    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: "sess-1" }),
      }),
    );
  });

  test("throws when no session ID returned", async () => {
    mockMessages([{ type: "text", text: "Done" }]);

    await expect(generateCode({ prompt: "test", workDir: "/tmp/app" })).rejects.toThrow(
      "did not return a session ID",
    );
  });
});
