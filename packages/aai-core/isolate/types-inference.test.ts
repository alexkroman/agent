// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for AgentDef and ToolDef type inference.
 *
 * These use vitest's expectTypeOf to verify that TypeScript correctly
 * infers parameter types, state types, and context types without
 * any runtime assertions. A failing type test means a type refactor
 * broke inference for consumers.
 */
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, Message, ToolContext, ToolDef } from "./types.ts";

describe("ToolDef type inference", () => {
  test("infers parameter types in execute args", () => {
    const _t: ToolDef<z.ZodObject<{ name: z.ZodString; count: z.ZodNumber }>> = {
      description: "test",
      parameters: z.object({ name: z.string(), count: z.number() }),
      execute: (args) => args,
    };

    // The execute function should receive typed args
    type Args = Parameters<typeof _t.execute>[0];
    expectTypeOf<Args>().toEqualTypeOf<{ name: string; count: number }>();
  });

  test("ToolDef without parameters has unknown args", () => {
    const _t: ToolDef = {
      description: "test",
      execute: (args) => args,
    };

    type Args = Parameters<typeof _t.execute>[0];
    // Without parameters, args is inferred from the base ZodObject
    expectTypeOf<Args>().toBeObject();
  });

  test("execute receives ToolContext as second arg", () => {
    const _t: ToolDef<z.ZodObject<{ x: z.ZodString }>> = {
      description: "test",
      parameters: z.object({ x: z.string() }),
      execute: (_args, ctx) => ctx,
    };

    type Ctx = Parameters<typeof _t.execute>[1];
    expectTypeOf<Ctx>().toMatchTypeOf<ToolContext>();
  });

  test("ToolContext provides kv, env, messages", () => {
    expectTypeOf<ToolContext>().toHaveProperty("kv");
    expectTypeOf<ToolContext>().toHaveProperty("env");
    expectTypeOf<ToolContext>().toHaveProperty("messages");
    expectTypeOf<ToolContext["messages"]>().toEqualTypeOf<readonly Message[]>();
    expectTypeOf<ToolContext["env"]>().toEqualTypeOf<Readonly<Record<string, string>>>();
  });
});

describe("AgentDef type inference", () => {
  test("satisfies AgentDef type", () => {
    const agent: AgentDef = {
      name: "test",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {},
    };
    expectTypeOf(agent).toMatchTypeOf<AgentDef>();
  });

  test("typed state flows through to tools", () => {
    type MyState = { counter: number; name: string };

    // This should compile without errors — state type flows
    // through to tool execute context
    const _agent: AgentDef<MyState> = {
      name: "typed-state",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      state: () => ({ counter: 0, name: "test" }),
      tools: {
        inc: {
          description: "Increment",
          execute: (_args, ctx) => {
            expectTypeOf(ctx.state).toEqualTypeOf<MyState>();
          },
        },
      },
    };
  });

  test("tools field accepts ToolDef objects", () => {
    const greet: ToolDef<z.ZodObject<{ name: z.ZodString }>> = {
      description: "Greet",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }: { name: string }) => `Hello, ${name}!`,
    };

    const agent: AgentDef = {
      name: "with-tool",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: { greet },
    };

    expectTypeOf(agent.tools).toHaveProperty("greet");
  });

  test("required fields are present", () => {
    const agent: AgentDef = {
      name: "defaults",
      systemPrompt: "Be helpful.",
      greeting: "Hello!",
      maxSteps: 5,
      tools: {},
    };
    expectTypeOf(agent.systemPrompt).toBeString();
    expectTypeOf(agent.greeting).toBeString();
    expectTypeOf(agent.tools).toBeObject();
  });
});
