/**
 * Test Patterns — comprehensive examples of every agent testing pattern.
 *
 * Use this as a reference when writing tests for your own agent.
 */

import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

// ─── 1. Basic tool execution ────────────────────────────────────────────────

describe("basic tool execution", () => {
  test("executeTool runs a single tool and returns the raw string result", async () => {
    const t = createTestHarness(agent);
    const result = await t.executeTool("add_task", { text: "Buy groceries" });
    // executeTool returns the raw string — parse it yourself
    const parsed = JSON.parse(result);
    expect(parsed.added.text).toBe("Buy groceries");
  });

  test("executeTool returns an error string for invalid arguments", async () => {
    const t = createTestHarness(agent);
    // "text" is required and must be non-empty
    const result = await t.executeTool("add_task", { text: "" });
    expect(result).toContain("error");
  });

  test("executeTool returns an error for unknown tools", async () => {
    const t = createTestHarness(agent);
    const result = await t.executeTool("nonexistent_tool", {});
    expect(result).toContain("error");
  });
});

// ─── 2. Turn simulation with tool calls ─────────────────────────────────────

describe("turn simulation", () => {
  test("turn() records the user message and executes tool calls", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Add a task for me", [
      { tool: "add_task", args: { text: "Write tests" } },
    ]);

    // Vitest custom matcher — clean, natural syntax
    expect(turn).toHaveCalledTool("add_task");
    expect(turn).not.toHaveCalledTool("complete_task");

    // User message was recorded
    expect(t.messages.at(0)?.content).toBe("Add a task for me");
  });

  test("turn() with no tool calls just records the user message", async () => {
    const t = createTestHarness(agent);
    await t.turn("Just chatting");
    expect(t.messages).toHaveLength(1);
  });

  test("multiple tool calls in a single turn execute in order", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Add two tasks", [
      { tool: "add_task", args: { text: "First" } },
      { tool: "add_task", args: { text: "Second" } },
    ]);
    expect(turn.toolCalls).toHaveLength(2);
    expect(turn.getToolCalls("add_task")).toHaveLength(2);
  });
});

// ─── 3. Typed tool results with toolResult<T>() ────────────────────────────

describe("typed tool results", () => {
  test("toolResult<T>() parses JSON and returns typed data", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Add a task", [{ tool: "add_task", args: { text: "Deploy app" } }]);

    // No JSON.parse needed — get typed result directly
    const result = turn.toolResult<{ added: { id: number; text: string }; total: number }>(
      "add_task",
    );
    expect(result.added.text).toBe("Deploy app");
    expect(result.added.id).toBe(1);
    expect(result.total).toBe(1);
  });

  test("toolResult() throws for tools that were not called", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Add task", [{ tool: "add_task", args: { text: "Something" } }]);
    expect(() => turn.toolResult("list_tasks")).toThrow("was not called");
  });
});

// ─── 4. Partial argument matching ───────────────────────────────────────────

describe("partial argument matching", () => {
  test("toHaveCalledTool checks specific args (partial match)", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Save a note", [
      { tool: "save_note", args: { key: "color", value: "blue" } },
    ]);

    // Match on a subset of args
    expect(turn).toHaveCalledTool("save_note", { key: "color" });
    expect(turn).toHaveCalledTool("save_note", { value: "blue" });
    expect(turn).toHaveCalledTool("save_note", { key: "color", value: "blue" });

    // Non-matching args
    expect(turn).not.toHaveCalledTool("save_note", { key: "size" });
  });
});

// ─── 5. Multi-turn conversation with state ──────────────────────────────────

describe("multi-turn state persistence", () => {
  test("agent state persists across turns", async () => {
    const t = createTestHarness(agent);

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

// ─── 6. Conversation history (ctx.messages) ─────────────────────────────────

describe("conversation history", () => {
  test("messages accumulate across turns", async () => {
    const t = createTestHarness(agent);
    await t.turn("First");
    t.addAssistantMessage("Got it.");
    await t.turn("Second");

    expect(t.messages).toHaveLength(3);
    expect(t.messages.at(0)?.role).toBe("user");
    expect(t.messages.at(1)?.role).toBe("assistant");
    expect(t.messages.at(2)?.role).toBe("user");
  });

  test("tools can read conversation history via ctx.messages", async () => {
    const t = createTestHarness(agent);

    // Pre-load some history
    t.addUserMessage("Hello");
    t.addAssistantMessage("Hi there");
    t.addUserMessage("How are you?");

    const turn = await t.turn("Count messages", [{ tool: "count_messages", args: {} }]);
    const result = turn.toolResult<{ total: number; byRole: Record<string, number> }>(
      "count_messages",
    );
    // 3 pre-loaded + 1 from this turn = 4
    expect(result.total).toBe(4);
    expect(result.byRole.user).toBe(3);
    expect(result.byRole.assistant).toBe(1);
  });

  test("reset() clears all conversation state", async () => {
    const t = createTestHarness(agent);
    await t.turn("Add task", [{ tool: "add_task", args: { text: "Test" } }]);
    expect(t.messages.length).toBeGreaterThan(0);
    expect(t.turns.length).toBeGreaterThan(0);

    t.reset();
    expect(t.messages).toHaveLength(0);
    expect(t.turns).toHaveLength(0);
  });
});

// ─── 7. Environment variables ───────────────────────────────────────────────

describe("environment variables", () => {
  test("env vars are available in tool context via ctx.env", async () => {
    const t = createTestHarness(agent, { env: { API_KEY: "sk-test-1234" } });
    const turn = await t.turn("Check env", [{ tool: "check_env", args: {} }]);
    const result = turn.toolResult<{ hasApiKey: boolean; keyPreview: string }>("check_env");
    expect(result.hasApiKey).toBe(true);
    expect(result.keyPreview).toBe("sk-t");
  });

  test("missing env vars are handled gracefully", async () => {
    const t = createTestHarness(agent); // no env
    const turn = await t.turn("Check env", [{ tool: "check_env", args: {} }]);
    const result = turn.toolResult<{ hasApiKey: boolean; keyPreview: string }>("check_env");
    expect(result.hasApiKey).toBe(false);
    expect(result.keyPreview).toBe("none");
  });
});

// ─── 8. KV store persistence ────────────────────────────────────────────────

describe("KV store", () => {
  test("data persists in KV across turns", async () => {
    const t = createTestHarness(agent);

    await t.turn("Save a note", [
      { tool: "save_note", args: { key: "meeting", value: "Tuesday 3pm" } },
    ]);

    const turn = await t.turn("Load the note", [{ tool: "load_note", args: { key: "meeting" } }]);
    expect(turn.toolResults[0]).toBe("Tuesday 3pm");
  });

  test("missing KV keys return not found", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Load missing", [
      { tool: "load_note", args: { key: "nonexistent" } },
    ]);
    expect(turn.toolResults[0]).toBe("not found");
  });

  test("save_note with TTL accepts expireIn option", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Save temp note", [
      { tool: "save_note", args: { key: "temp", value: "expires soon", ttl_ms: 60_000 } },
    ]);
    expect(turn).toHaveCalledTool("save_note", { key: "temp", ttl_ms: 60_000 });
    const result = turn.toolResult<{ saved: boolean; key: string }>("save_note");
    expect(result.saved).toBe(true);
  });

  test("delete_note removes a key from KV", async () => {
    const t = createTestHarness(agent);

    await t.turn("Save", [{ tool: "save_note", args: { key: "deleteme", value: "gone soon" } }]);
    await t.turn("Delete", [{ tool: "delete_note", args: { key: "deleteme" } }]);

    const turn = await t.turn("Load deleted", [{ tool: "load_note", args: { key: "deleteme" } }]);
    expect(turn.toolResults[0]).toBe("not found");
  });

  test("list_notes returns saved entries by prefix", async () => {
    const t = createTestHarness(agent);

    await t.turn("Save notes", [
      { tool: "save_note", args: { key: "a", value: "alpha" } },
      { tool: "save_note", args: { key: "b", value: "beta" } },
    ]);

    const turn = await t.turn("List notes", [{ tool: "list_notes", args: {} }]);
    const result = turn.toolResult<{ notes: { key: string; value: string }[]; total: number }>(
      "list_notes",
    );
    expect(result.total).toBe(2);
    expect(result.notes.map((n) => n.value)).toContain("alpha");
    expect(result.notes.map((n) => n.value)).toContain("beta");
  });

  test("search_notes finds keys by pattern", async () => {
    const t = createTestHarness(agent);

    await t.turn("Save notes", [
      { tool: "save_note", args: { key: "project:x", value: "data x" } },
      { tool: "save_note", args: { key: "project:y", value: "data y" } },
    ]);

    const turn = await t.turn("Search", [
      { tool: "search_notes", args: { pattern: "note:project:*" } },
    ]);
    const result = turn.toolResult<{ keys: string[]; total: number }>("search_notes");
    expect(result.total).toBe(2);
  });
});

// ─── 9. Lifecycle hooks ─────────────────────────────────────────────────────

describe("lifecycle hooks", () => {
  test("onConnect fires automatically on first turn", async () => {
    const t = createTestHarness(agent);

    // onConnect sets owner = "connected-user"
    const turn = await t.turn("Who owns this?", [{ tool: "get_owner", args: {} }]);
    const result = turn.toolResult<{ owner: string }>("get_owner");
    expect(result.owner).toBe("connected-user");
  });

  test("connect() and disconnect() can be called manually", async () => {
    const t = createTestHarness(agent);
    await t.connect();
    // Verify onConnect ran
    const turn = await t.turn("Check owner", [{ tool: "get_owner", args: {} }]);
    expect(turn.toolResult<{ owner: string }>("get_owner").owner).toBe("connected-user");
    await t.disconnect();
  });

  test("onDisconnect saves tasks to KV", async () => {
    const t = createTestHarness(agent);

    // Add tasks then disconnect
    await t.turn("Add tasks", [{ tool: "add_task", args: { text: "Saved task" } }]);
    await t.disconnect();

    // Verify onDisconnect persisted tasks to KV via load
    const turn = await t.turn("Search KV", [
      { tool: "search_notes", args: { pattern: "session:*" } },
    ]);
    const result = turn.toolResult<{ keys: string[]; total: number }>("search_notes");
    expect(result.keys).toContain("session:tasks");
  });

  test("onUserTranscript hook fires and is tracked", async () => {
    const t = createTestHarness(agent);
    await t.turn("First message");
    await t.turn("Second message");

    // t.turns tracks onUserTranscript invocations
    expect(t.turns).toEqual(["First message", "Second message"]);
  });
});

// ─── 10. Built-in tools ─────────────────────────────────────────────────────

describe("built-in tools", () => {
  test("run_code executes JavaScript in a sandbox", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Calculate something", [
      { tool: "run_code", args: { code: "console.log(Math.sqrt(144))" } },
    ]);
    expect(turn).toHaveCalledTool("run_code");
    expect(turn.toolResults[0]).toBe("12");
  });
});

// ─── 11. Session metadata (ctx.sessionId) ──────────────────────────────────

describe("session metadata", () => {
  test("session_info returns sessionId and state summary", async () => {
    const t = createTestHarness(agent);
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
