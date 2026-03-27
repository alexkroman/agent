import { describe, expect, test, vi } from "vitest";
import { createStatus } from "./_status.ts";

function mockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "msg-ts-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("createStatus", () => {
  test("posts initial message in thread", async () => {
    const client = mockClient();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    await createStatus(client as any, "C123", "thread-1", "Starting...");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "thread-1",
      text: "Starting...",
    });
  });

  test("update overwrites the same message", async () => {
    const client = mockClient();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const status = await createStatus(client as any, "C123", "thread-1", "Starting...");

    await status.update("Deploying...");

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg-ts-1",
      text: "Deploying...",
    });
  });

  test("multiple updates all target the same message ts", async () => {
    const client = mockClient();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const status = await createStatus(client as any, "C123", "thread-1", "Step 1");

    await status.update("Step 2");
    await status.update("Step 3");

    expect(client.chat.update).toHaveBeenCalledTimes(2);
    for (const call of client.chat.update.mock.calls) {
      expect(call[0].ts).toBe("msg-ts-1");
    }
  });
});
