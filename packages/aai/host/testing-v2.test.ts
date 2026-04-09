// Copyright 2025 the AAI authors. MIT license.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDirTestHarness, TurnResult } from "./testing-v2.ts";

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "aai-test-harness-"));
  await mkdir(join(agentDir, "tools"), { recursive: true });
  await mkdir(join(agentDir, "hooks"), { recursive: true });
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeTool(name: string, code: string) {
  await writeFile(join(agentDir, "tools", `${name}.mjs`), code);
}

async function writeHook(name: string, code: string) {
  await writeFile(join(agentDir, "hooks", `${name}.mjs`), code);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createDirTestHarness", () => {
  test("executes a tool from a directory agent", async () => {
    await writeTool(
      "greet",
      `
      export default async function(args) {
        return "Hello, " + args.name + "!";
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    const result = await t.executeTool("greet", { name: "Alice" });
    expect(result).toBe("Hello, Alice!");
  });

  test("tool receives ctx with kv and sessionId", async () => {
    await writeTool(
      "save",
      `
      export default async function(args, ctx) {
        await ctx.kv.set(args.key, args.value);
        return "saved";
      }
      `,
    );
    await writeTool(
      "load",
      `
      export default async function(args, ctx) {
        const val = await ctx.kv.get(args.key);
        return { value: val, sessionId: ctx.sessionId };
      }
      `,
    );

    const t = await createDirTestHarness(agentDir, { sessionId: "sess-42" });
    await t.executeTool("save", { key: "color", value: "blue" });
    const result = await t.executeTool("load", { key: "color" });
    expect(result).toEqual({ value: "blue", sessionId: "sess-42" });
  });

  test("KV persists across tool calls", async () => {
    await writeTool(
      "increment",
      `
      export default async function(args, ctx) {
        const current = (await ctx.kv.get("counter")) || 0;
        const next = current + 1;
        await ctx.kv.set("counter", next);
        return next;
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    const r1 = await t.executeTool("increment");
    const r2 = await t.executeTool("increment");
    const r3 = await t.executeTool("increment");
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
  });

  test("throws for unknown tool", async () => {
    const t = await createDirTestHarness(agentDir);
    await expect(t.executeTool("nonexistent")).rejects.toThrow('Tool "nonexistent" not found');
  });

  test("works with empty directories", async () => {
    const t = await createDirTestHarness(agentDir);
    expect(t.messages).toHaveLength(0);
  });

  test("works when tools/ and hooks/ do not exist", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "aai-empty-"));
    try {
      const t = await createDirTestHarness(emptyDir);
      expect(t.messages).toHaveLength(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("hooks", () => {
  test("fires onConnect hook", async () => {
    await writeHook(
      "on-connect",
      `
      export default async function(ctx) {
        await ctx.kv.set("connected", true);
      }
      `,
    );
    await writeTool(
      "check-connected",
      `
      export default async function(args, ctx) {
        return await ctx.kv.get("connected");
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    await t.connect();

    const result = await t.executeTool("check-connected");
    expect(result).toBe(true);
  });

  test("fires onDisconnect hook", async () => {
    await writeHook(
      "on-disconnect",
      `
      export default async function(ctx) {
        await ctx.kv.set("disconnected", true);
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    await t.disconnect();
    const val = await t.kv.get("disconnected");
    expect(val).toBe(true);
  });

  test("fires onUserTranscript hook during turn", async () => {
    await writeHook(
      "on-user-transcript",
      `
      export default async function(ctx) {
        const count = (await ctx.kv.get("turn-count")) || 0;
        await ctx.kv.set("turn-count", count + 1);
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    await t.turn("first message");
    await t.turn("second message");

    const count = await t.kv.get("turn-count");
    expect(count).toBe(2);
  });
});

describe("turn", () => {
  test("simulates tool calls in sequence and returns TurnResult", async () => {
    await writeTool(
      "add-item",
      `
      export default async function(args, ctx) {
        const items = (await ctx.kv.get("items")) || [];
        items.push(args.item);
        await ctx.kv.set("items", items);
        return { added: args.item, count: items.length };
      }
      `,
    );
    await writeTool(
      "get-items",
      `
      export default async function(args, ctx) {
        return (await ctx.kv.get("items")) || [];
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);

    const turn1 = await t.turn("Add apples and bananas", [
      { tool: "add-item", args: { item: "apple" } },
      { tool: "add-item", args: { item: "banana" } },
    ]);

    expect(turn1.toolCalls).toHaveLength(2);
    expect(turn1.toolCalls[0]?.name).toBe("add-item");
    expect(turn1.toolCalls[0]?.result).toEqual({ added: "apple", count: 1 });
    expect(turn1.toolCalls[1]?.result).toEqual({ added: "banana", count: 2 });

    const turn2 = await t.turn("Show items", [{ tool: "get-items", args: {} }]);
    const items = turn2.toolResult<string[]>("get-items");
    expect(items).toEqual(["apple", "banana"]);
  });

  test("records user and tool messages in conversation history", async () => {
    await writeTool(
      "echo",
      `
      export default async function(args) {
        return "echoed: " + args.text;
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    await t.turn("hello", [{ tool: "echo", args: { text: "hello" } }]);

    expect(t.messages).toHaveLength(2);
    expect(t.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(t.messages[1]).toEqual({ role: "tool", content: "echoed: hello" });
  });

  test("tool receives accumulated messages in ctx", async () => {
    await writeTool(
      "count-messages",
      `
      export default async function(args, ctx) {
        return ctx.messages.length;
      }
      `,
    );

    const t = await createDirTestHarness(agentDir);
    const turn1 = await t.turn("first", [{ tool: "count-messages", args: {} }]);
    // 1 user message at time of tool execution
    expect(turn1.toolResult("count-messages")).toBe(1);

    const turn2 = await t.turn("second", [{ tool: "count-messages", args: {} }]);
    // 1 user + 1 tool from turn1 + 1 user from turn2 = 3
    expect(turn2.toolResult("count-messages")).toBe(3);
  });

  test("env is passed through to tools", async () => {
    await writeTool(
      "read-env",
      `
      export default async function(args, ctx) {
        return ctx.env.MY_SECRET || "missing";
      }
      `,
    );

    const t = await createDirTestHarness(agentDir, { env: { MY_SECRET: "s3cr3t" } });
    const result = await t.executeTool("read-env");
    expect(result).toBe("s3cr3t");
  });
});

describe("TurnResult", () => {
  test("toolResult throws for uncalled tool", () => {
    const result = new TurnResult([{ name: "foo", args: {}, result: "bar" }]);
    expect(() => result.toolResult("baz")).toThrow('Tool "baz" was not called during this turn');
  });

  test("toolResult returns typed result", () => {
    const result = new TurnResult([{ name: "calc", args: { x: 1 }, result: { sum: 42 } }]);
    const val = result.toolResult<{ sum: number }>("calc");
    expect(val.sum).toBe(42);
  });
});
