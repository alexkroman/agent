/**
 * Test Patterns -- comprehensive examples of every agent testing pattern
 * using the directory-based test harness.
 *
 * Use this as a reference when writing tests for your own agent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// --- 1. Basic tool execution ------------------------------------------------

describe("basic tool execution", () => {
  test("executeTool runs a single tool and returns the result", async () => {
    const t = await createTestHarness(join(__dirname));
    const result = (await t.executeTool("add_task", { text: "Buy groceries" })) as {
      added: { text: string };
    };
    expect(result.added.text).toBe("Buy groceries");
  });

  test("executeTool throws for unknown tools", async () => {
    const t = await createTestHarness(join(__dirname));
    await expect(t.executeTool("nonexistent_tool", {})).rejects.toThrow("not found");
  });
});

// --- 2. Turn simulation with tool calls -------------------------------------

describe("turn simulation", () => {
  test("turn() records the user message and executes tool calls", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Add a task for me", [
      { tool: "add_task", args: { text: "Write tests" } },
    ]);

    // Check that add_task was called
    expect(turn.toolCalls.some((tc) => tc.name === "add_task")).toBe(true);
    expect(turn.toolCalls.some((tc) => tc.name === "complete_task")).toBe(false);

    // User message was recorded
    expect(t.messages.at(0)?.content).toBe("Add a task for me");
  });

  test("turn() with no tool calls just records the user message", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.turn("Just chatting");
    expect(t.messages).toHaveLength(1);
  });

  test("multiple tool calls in a single turn execute in order", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Add two tasks", [
      { tool: "add_task", args: { text: "First" } },
      { tool: "add_task", args: { text: "Second" } },
    ]);
    expect(turn.toolCalls).toHaveLength(2);
    expect(turn.toolCalls.filter((tc) => tc.name === "add_task")).toHaveLength(2);
  });
});

// --- 3. Typed tool results with toolResult<T>() ----------------------------

describe("typed tool results", () => {
  test("toolResult<T>() returns typed data", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Add a task", [{ tool: "add_task", args: { text: "Deploy app" } }]);

    const result = turn.toolResult<{ added: { id: number; text: string }; total: number }>(
      "add_task",
    );
    expect(result.added.text).toBe("Deploy app");
    expect(result.added.id).toBe(1);
    expect(result.total).toBe(1);
  });

  test("toolResult() throws for tools that were not called", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Add task", [{ tool: "add_task", args: { text: "Something" } }]);
    expect(() => turn.toolResult("list_tasks")).toThrow("was not called");
  });
});

// --- 4. Partial argument matching -------------------------------------------

describe("partial argument matching", () => {
  test("toolCalls contain the full args for inspection", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Save a note", [
      { tool: "save_note", args: { key: "color", value: "blue" } },
    ]);

    const call = turn.toolCalls.find((tc) => tc.name === "save_note");
    expect(call).toBeDefined();
    expect(call!.args).toEqual(expect.objectContaining({ key: "color" }));
    expect(call!.args).toEqual(expect.objectContaining({ value: "blue" }));
    expect(call!.args).toEqual(expect.objectContaining({ key: "color", value: "blue" }));
  });
});

// --- 5. Multi-turn conversation with state ----------------------------------

describe("multi-turn state persistence", () => {
  test("agent state persists across turns", async () => {
    const t = await createTestHarness(join(__dirname));

    // Turn 1: add tasks
    await t.turn("Add tasks", [
      { tool: "add_task", args: { text: "Task A" } },
      { tool: "add_task", args: { text: "Task B" } },
    ]);

    // Turn 2: complete one
    await t.turn("Complete task 1", [{ tool: "complete_task", args: { id: 1 } }]);

    // Turn 3: verify state
    const turn = await t.turn("Show tasks", [{ tool: "list_tasks", args: {} }]);
    const list = turn.toolResult<{
      tasks: { id: number; text: string; done: boolean }[];
      total: number;
      completed: number;
    }>("list_tasks");

    expect(list.total).toBe(2);
    expect(list.completed).toBe(1);
    expect(list.tasks[0]?.done).toBe(true);
    expect(list.tasks[1]?.done).toBe(false);
  });
});

// --- 6. Conversation history (ctx.messages) ---------------------------------

describe("conversation history", () => {
  test("messages accumulate across turns", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.turn("First");
    await t.turn("Second");

    // Each turn adds a user message
    expect(t.messages).toHaveLength(2);
    expect(t.messages.at(0)?.role).toBe("user");
    expect(t.messages.at(1)?.role).toBe("user");
  });

  test("tools can read conversation history via ctx.messages", async () => {
    const t = await createTestHarness(join(__dirname));

    // Create some history via turns
    await t.turn("Hello");
    await t.turn("How are you?");

    const turn = await t.turn("Count messages", [{ tool: "count_messages", args: {} }]);
    const result = turn.toolResult<{ total: number; byRole: Record<string, number> }>(
      "count_messages",
    );
    // 2 previous turns + 1 from this turn = 3 user messages
    expect(result.total).toBe(3);
    expect(result.byRole.user).toBe(3);
  });
});

// --- 7. Environment variables -----------------------------------------------

describe("environment variables", () => {
  test("env vars are available in tool context via ctx.env", async () => {
    const t = await createTestHarness(join(__dirname), { env: { API_KEY: "sk-test-1234" } });
    const turn = await t.turn("Check env", [{ tool: "check_env", args: {} }]);
    const result = turn.toolResult<{ hasApiKey: boolean; keyPreview: string }>("check_env");
    expect(result.hasApiKey).toBe(true);
    expect(result.keyPreview).toBe("sk-t");
  });

  test("missing env vars are handled gracefully", async () => {
    const t = await createTestHarness(join(__dirname)); // no env
    const turn = await t.turn("Check env", [{ tool: "check_env", args: {} }]);
    const result = turn.toolResult<{ hasApiKey: boolean; keyPreview: string }>("check_env");
    expect(result.hasApiKey).toBe(false);
    expect(result.keyPreview).toBe("none");
  });
});

// --- 8. KV store persistence ------------------------------------------------

describe("KV store", () => {
  test("data persists in KV across turns", async () => {
    const t = await createTestHarness(join(__dirname));

    await t.turn("Save a note", [
      { tool: "save_note", args: { key: "meeting", value: "Tuesday 3pm" } },
    ]);

    const turn = await t.turn("Load the note", [{ tool: "load_note", args: { key: "meeting" } }]);
    expect(turn.toolResult("load_note")).toBe("Tuesday 3pm");
  });

  test("missing KV keys return not found", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Load missing", [
      { tool: "load_note", args: { key: "nonexistent" } },
    ]);
    expect(turn.toolResult("load_note")).toBe("not found");
  });

  test("save_note with TTL accepts expireIn option", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Save temp note", [
      { tool: "save_note", args: { key: "temp", value: "expires soon", ttl_ms: 60_000 } },
    ]);
    const call = turn.toolCalls.find((tc) => tc.name === "save_note");
    expect(call).toBeDefined();
    expect(call!.args).toEqual(expect.objectContaining({ key: "temp", ttl_ms: 60_000 }));
    const result = turn.toolResult<{ saved: boolean; key: string }>("save_note");
    expect(result.saved).toBe(true);
  });

  test("delete_note removes a key from KV", async () => {
    const t = await createTestHarness(join(__dirname));

    await t.turn("Save", [{ tool: "save_note", args: { key: "deleteme", value: "gone soon" } }]);
    await t.turn("Delete", [{ tool: "delete_note", args: { key: "deleteme" } }]);

    const turn = await t.turn("Load deleted", [{ tool: "load_note", args: { key: "deleteme" } }]);
    expect(turn.toolResult("load_note")).toBe("not found");
  });
});

// --- 9. Lifecycle hooks -----------------------------------------------------

describe("lifecycle hooks", () => {
  test("onConnect sets up state accessible to tools", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.connect();

    const turn = await t.turn("Who owns this?", [{ tool: "get_owner", args: {} }]);
    const result = turn.toolResult<{ owner: string }>("get_owner");
    expect(result.owner).toBe("connected-user");
  });

  test("connect() and disconnect() can be called manually", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.connect();
    // Verify onConnect ran
    const turn = await t.turn("Check owner", [{ tool: "get_owner", args: {} }]);
    expect(turn.toolResult<{ owner: string }>("get_owner").owner).toBe("connected-user");
    await t.disconnect();
  });

  test("onDisconnect runs without error", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.turn("Add tasks", [{ tool: "add_task", args: { text: "Saved task" } }]);
    // disconnect() calls onDisconnect which persists tasks to KV
    await expect(t.disconnect()).resolves.toBeUndefined();
  });
});

// --- 10. Session metadata (ctx.sessionId) -----------------------------------

describe("session metadata", () => {
  test("session_info returns sessionId and state summary", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.connect();
    await t.turn("Add task", [{ tool: "add_task", args: { text: "Item" } }]);

    const turn = await t.turn("Session info", [{ tool: "session_info", args: {} }]);
    const info = turn.toolResult<{
      sessionId: string;
      owner: string;
      taskCount: number;
      lastError: string | null;
    }>("session_info");

    expect(info.sessionId).toBeTruthy();
    expect(info.owner).toBe("connected-user");
    expect(info.taskCount).toBe(1);
    expect(info.lastError).toBeNull();
  });
});
