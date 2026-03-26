// Copyright 2025 the AAI authors. MIT license.
/// <reference path="./matchers.d.ts" />

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestHarness } from "./testing.ts";
import { defineAgent, defineTool } from "./types.ts";

const pizzaAgent = defineAgent({
  name: "Pizza Agent",
  state: () => ({ pizzas: [] as { size: string; toppings: string[] }[], placed: false }),
  tools: {
    add_pizza: defineTool({
      description: "Add a pizza to the order",
      parameters: z.object({
        size: z.enum(["small", "medium", "large"]),
        toppings: z.array(z.string()),
      }),
      execute: (args, ctx) => {
        const state = ctx.state as { pizzas: { size: string; toppings: string[] }[] };
        state.pizzas.push({ size: args.size, toppings: args.toppings });
        return { added: { size: args.size, toppings: args.toppings }, count: state.pizzas.length };
      },
    }),
    view_order: {
      description: "View current order",
      execute: (_args, ctx) => {
        const state = ctx.state as { pizzas: { size: string; toppings: string[] }[] };
        return { pizzas: state.pizzas, count: state.pizzas.length };
      },
    },
    place_order: {
      description: "Place the order",
      execute: (_args, ctx) => {
        const state = ctx.state as {
          pizzas: { size: string; toppings: string[] }[];
          placed: boolean;
        };
        if (state.pizzas.length === 0) return { error: "No pizzas in order" };
        state.placed = true;
        return { placed: true, count: state.pizzas.length };
      },
    },
  },
});

describe("createTestHarness", () => {
  test("executeTool runs a tool and returns the result", async () => {
    const t = createTestHarness(pizzaAgent);
    const result = await t.executeTool("add_pizza", { size: "large", toppings: ["pepperoni"] });
    const parsed = JSON.parse(result);
    expect(parsed.added.size).toBe("large");
    expect(parsed.count).toBe(1);
  });

  test("executeTool returns error for unknown tool", async () => {
    const t = createTestHarness(pizzaAgent);
    const result = await t.executeTool("nonexistent", {});
    expect(result).toContain("error");
  });

  test("executeTool validates arguments", async () => {
    const t = createTestHarness(pizzaAgent);
    const result = await t.executeTool("add_pizza", { size: "huge", toppings: [] });
    expect(result).toContain("Error");
  });

  test("env vars are passed to tool context", async () => {
    const agent = defineAgent({
      name: "env-test",
      tools: {
        read_key: {
          description: "Read an env var",
          execute: (_args, ctx) => ctx.env.MY_KEY ?? "missing",
        },
      },
    });
    const t = createTestHarness(agent, { env: { MY_KEY: "secret123" } });
    const result = await t.executeTool("read_key");
    expect(result).toBe("secret123");
  });
});

describe("TestHarness.turn", () => {
  test("records user message in conversation history", async () => {
    const t = createTestHarness(pizzaAgent);
    await t.turn("I want a pizza");
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toEqual({ role: "user", content: "I want a pizza" });
  });

  test("executes tool calls and records results", async () => {
    const t = createTestHarness(pizzaAgent);
    const turn = await t.turn("Add a large pepperoni", [
      { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
    ]);
    expect(turn).toHaveCalledTool("add_pizza");
    const result = turn.toolResult<{ added: { size: string }; count: number }>("add_pizza");
    expect(result.added.size).toBe("large");
  });

  test("records tool messages in conversation history", async () => {
    const t = createTestHarness(pizzaAgent);
    await t.turn("Add a pizza", [{ tool: "add_pizza", args: { size: "small", toppings: [] } }]);
    // user message + tool result
    expect(t.messages).toHaveLength(2);
    expect(t.messages.at(0)?.role).toBe("user");
    expect(t.messages.at(1)?.role).toBe("tool");
  });

  test("fires onTurn hook", async () => {
    const turnTexts: string[] = [];
    const agent = defineAgent({
      name: "hook-test",
      onTurn: (text) => {
        turnTexts.push(text);
      },
      tools: {},
    });
    const t = createTestHarness(agent);
    await t.turn("hello");
    await t.turn("world");
    expect(turnTexts).toEqual(["hello", "world"]);
    expect(t.turns).toEqual(["hello", "world"]);
  });

  test("fires onStep hook for each tool call", async () => {
    const t = createTestHarness(pizzaAgent);
    await t.turn("Two pizzas please", [
      { tool: "add_pizza", args: { size: "small", toppings: ["cheese"] } },
      { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
    ]);
    expect(t.steps).toHaveLength(2);
    expect(t.steps.at(0)?.stepNumber).toBe(1);
    expect(t.steps.at(1)?.stepNumber).toBe(2);
  });

  test("fires onConnect on first turn", async () => {
    const log: string[] = [];
    const agent = defineAgent({
      name: "connect-test",
      onConnect: () => {
        log.push("connected");
      },
      tools: {},
    });
    const t = createTestHarness(agent);
    await t.turn("first");
    await t.turn("second");
    // onConnect fires only once
    expect(log).toEqual(["connected"]);
  });
});

describe("TurnResult assertions", () => {
  test("toHaveCalledTool vitest matcher checks tool name", async () => {
    const t = createTestHarness(pizzaAgent);
    const turn = await t.turn("Add pizza", [
      { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
    ]);
    expect(turn).toHaveCalledTool("add_pizza");
    expect(turn).not.toHaveCalledTool("view_order");
  });

  test("toHaveCalledTool vitest matcher checks partial args", async () => {
    const t = createTestHarness(pizzaAgent);
    const turn = await t.turn("Add pizza", [
      { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni", "mushrooms"] } },
    ]);
    expect(turn).toHaveCalledTool("add_pizza", { size: "large" });
    expect(turn).not.toHaveCalledTool("add_pizza", { size: "small" });
    expect(turn).toHaveCalledTool("add_pizza", { toppings: ["pepperoni", "mushrooms"] });
  });

  test("getToolCalls filters by name", async () => {
    const t = createTestHarness(pizzaAgent);
    const turn = await t.turn("Add two pizzas", [
      { tool: "add_pizza", args: { size: "small", toppings: [] } },
      { tool: "view_order", args: {} },
      { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
    ]);
    expect(turn.getToolCalls("add_pizza")).toHaveLength(2);
    expect(turn.getToolCalls("view_order")).toHaveLength(1);
    expect(turn.getToolCalls("place_order")).toHaveLength(0);
  });

  test("toolResult returns typed parsed JSON", async () => {
    const t = createTestHarness(pizzaAgent);
    const turn = await t.turn("Add pizza", [
      { tool: "add_pizza", args: { size: "medium", toppings: [] } },
    ]);
    const result = turn.toolResult<{ added: { size: string }; count: number }>("add_pizza");
    expect(result.added.size).toBe("medium");
    expect(result.count).toBe(1);
  });

  test("toolResult throws for uncalled tool", async () => {
    const t = createTestHarness(pizzaAgent);
    const turn = await t.turn("Add pizza", [
      { tool: "add_pizza", args: { size: "small", toppings: [] } },
    ]);
    expect(() => turn.toolResult("view_order")).toThrow('Tool "view_order" was not called');
  });
});

describe("multi-turn conversation", () => {
  test("state persists across turns", async () => {
    const t = createTestHarness(pizzaAgent);

    await t.turn("Add first pizza", [
      { tool: "add_pizza", args: { size: "small", toppings: ["cheese"] } },
    ]);

    await t.turn("Add second pizza", [
      { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
    ]);

    const turn3 = await t.turn("Show me the order", [{ tool: "view_order", args: {} }]);
    const order = turn3.toolResult<{ count: number; pizzas: unknown[] }>("view_order");
    expect(order.count).toBe(2);
    expect(order.pizzas).toHaveLength(2);
  });

  test("messages accumulate across turns", async () => {
    const t = createTestHarness(pizzaAgent);
    await t.turn("First message");
    t.addAssistantMessage("Sure, I can help.");
    await t.turn("Second message");

    expect(t.messages).toHaveLength(3);
    expect(t.messages.at(0)?.role).toBe("user");
    expect(t.messages.at(1)?.role).toBe("assistant");
    expect(t.messages.at(2)?.role).toBe("user");
  });

  test("conversation history is available in tool context", async () => {
    const agent = defineAgent({
      name: "history-test",
      tools: {
        count_messages: {
          description: "Count messages",
          execute: (_args, ctx) => String(ctx.messages.length),
        },
      },
    });
    const t = createTestHarness(agent);

    t.addUserMessage("Hello");
    t.addAssistantMessage("Hi there");

    const turn = await t.turn("How many messages?", [{ tool: "count_messages", args: {} }]);
    // 2 pre-added + 1 from this turn
    expect(turn.toolCalls.at(0)?.result).toBe("3");
  });

  test("reset clears conversation state", async () => {
    const t = createTestHarness(pizzaAgent);
    await t.turn("Add pizza", [{ tool: "add_pizza", args: { size: "small", toppings: [] } }]);
    expect(t.messages.length).toBeGreaterThan(0);
    expect(t.steps.length).toBeGreaterThan(0);

    t.reset();
    expect(t.messages).toHaveLength(0);
    expect(t.steps).toHaveLength(0);
    expect(t.turns).toHaveLength(0);
  });
});

describe("lifecycle hooks", () => {
  test("connect and disconnect fire correctly", async () => {
    const log: string[] = [];
    const agent = defineAgent({
      name: "lifecycle-test",
      onConnect: () => {
        log.push("connect");
      },
      onDisconnect: () => {
        log.push("disconnect");
      },
      tools: {},
    });

    const t = createTestHarness(agent);
    await t.connect();
    await t.disconnect();
    expect(log).toEqual(["connect", "disconnect"]);
  });

  test("connect is idempotent", async () => {
    let count = 0;
    const agent = defineAgent({
      name: "idempotent-test",
      onConnect: () => {
        count++;
      },
      tools: {},
    });

    const t = createTestHarness(agent);
    await t.connect();
    await t.connect();
    await t.connect();
    expect(count).toBe(1);
  });
});

describe("KV and vector store", () => {
  test("kv store is accessible in tools", async () => {
    const agent = defineAgent({
      name: "kv-test",
      tools: {
        save: defineTool({
          description: "Save to KV",
          parameters: z.object({ key: z.string(), value: z.string() }),
          execute: async (args, ctx) => {
            await ctx.kv.set(args.key, args.value);
            return "saved";
          },
        }),
        load: defineTool({
          description: "Load from KV",
          parameters: z.object({ key: z.string() }),
          execute: async (args, ctx) => (await ctx.kv.get<string>(args.key)) ?? "not found",
        }),
      },
    });

    const t = createTestHarness(agent);
    await t.turn("Save data", [{ tool: "save", args: { key: "color", value: "blue" } }]);
    const turn = await t.turn("Load data", [{ tool: "load", args: { key: "color" } }]);
    expect(turn.toolCalls.at(0)?.result).toBe("blue");
  });
});
