// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for defineAgent and defineTool() type inference.
 *
 * These use vitest's expectTypeOf to verify that TypeScript correctly
 * infers parameter types, state types, and context types without
 * any runtime assertions. A failing type test means a type refactor
 * broke inference for consumers.
 */
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, HookContext, Message, ToolContext, ToolDef } from "./types.ts";
import { defineAgent, defineTool } from "./types.ts";

describe("defineTool() type inference", () => {
  test("infers parameter types in execute args", () => {
    const _t = defineTool({
      description: "test",
      parameters: z.object({ name: z.string(), count: z.number() }),
      execute: (args) => args,
    });

    // The execute function should receive typed args
    type Args = Parameters<typeof _t.execute>[0];
    expectTypeOf<Args>().toEqualTypeOf<{ name: string; count: number }>();
  });

  test("defineTool without parameters has unknown args", () => {
    const _t: ToolDef = {
      description: "test",
      execute: (args) => args,
    };

    type Args = Parameters<typeof _t.execute>[0];
    // Without parameters, args is inferred from the base ZodObject
    expectTypeOf<Args>().toBeObject();
  });

  test("execute receives ToolContext as second arg", () => {
    const _t = defineTool({
      description: "test",
      parameters: z.object({ x: z.string() }),
      execute: (_args, ctx) => ctx,
    });

    type Ctx = Parameters<typeof _t.execute>[1];
    expectTypeOf<Ctx>().toMatchTypeOf<ToolContext>();
  });

  test("ToolContext provides kv, vector, env, messages", () => {
    expectTypeOf<ToolContext>().toHaveProperty("kv");
    expectTypeOf<ToolContext>().toHaveProperty("vector");
    expectTypeOf<ToolContext>().toHaveProperty("env");
    expectTypeOf<ToolContext>().toHaveProperty("messages");
    expectTypeOf<ToolContext["messages"]>().toEqualTypeOf<readonly Message[]>();
    expectTypeOf<ToolContext["env"]>().toEqualTypeOf<Readonly<Record<string, string>>>();
  });

  test("HookContext omits messages", () => {
    expectTypeOf<HookContext>().toHaveProperty("kv");
    expectTypeOf<HookContext>().toHaveProperty("env");
    expectTypeOf<HookContext>().not.toHaveProperty("messages");
  });
});

describe("defineAgent type inference", () => {
  test("returns AgentDef", () => {
    const agent = defineAgent({ name: "test" });
    expectTypeOf(agent).toMatchTypeOf<AgentDef>();
  });

  test("typed state flows through to hooks and tools", () => {
    type MyState = { counter: number; name: string };

    // This should compile without errors — state type flows
    // through to onConnect, onTurn, and tool execute context
    defineAgent<MyState>({
      name: "typed-state",
      state: () => ({ counter: 0, name: "test" }),
      onConnect: (ctx) => {
        expectTypeOf(ctx.state).toEqualTypeOf<MyState>();
      },
      onTurn: (_text, ctx) => {
        expectTypeOf(ctx.state).toEqualTypeOf<MyState>();
      },
      tools: {
        inc: {
          description: "Increment",
          execute: (_args, ctx) => {
            expectTypeOf(ctx.state).toEqualTypeOf<MyState>();
          },
        },
      },
    });
  });

  test("tools field accepts defineTool() wrapped definitions", () => {
    const greet = defineTool({
      description: "Greet",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => `Hello, ${name}!`,
    });

    const agent = defineAgent({
      name: "with-tool",
      tools: { greet },
    });

    expectTypeOf(agent.tools).toHaveProperty("greet");
  });

  test("default values are applied", () => {
    const agent = defineAgent({ name: "defaults" });
    expectTypeOf(agent.instructions).toBeString();
    expectTypeOf(agent.greeting).toBeString();
    expectTypeOf(agent.tools).toBeObject();
  });
});
