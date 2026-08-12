// Copyright 2025 the AAI authors. MIT license.
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, InferToolInput, Message, ToolContext, ToolDef } from "./types.ts";

const baseAgent = {
  systemPrompt: "Be helpful.",
  greeting: "Hello!",
  maxSteps: 5,
} as const;

describe("ToolDef type inference", () => {
  test("infers parameter types in run args", () => {
    const _t: ToolDef<z.ZodObject<{ name: z.ZodString; count: z.ZodNumber }>> = {
      description: "test",
      input: z.object({ name: z.string(), count: z.number() }),
      run: (args) => args,
    };

    expectTypeOf<InferToolInput<typeof _t>>().toEqualTypeOf<{ name: string; count: number }>();
  });

  // The deprecated spelling has to keep inferring identically for the major it
  // survives — `InferToolInput` reads whichever half is present, so a def on the
  // old names is the case that proves the reader is not just following `run`.
  test("the deprecated inputSchema/execute pair infers the same args", () => {
    const _t: ToolDef<z.ZodObject<{ name: z.ZodString; count: z.ZodNumber }>> = {
      description: "test",
      input: z.object({ name: z.string(), count: z.number() }),
      run: (args) => args,
    };

    expectTypeOf<InferToolInput<typeof _t>>().toEqualTypeOf<{ name: string; count: number }>();
  });

  test("ToolDef without parameters has unknown args", () => {
    const _t: ToolDef = {
      description: "test",
      run: (args) => args,
    };

    expectTypeOf<InferToolInput<typeof _t>>().toBeObject();
  });

  test("run receives ToolContext as second arg", () => {
    const _t: ToolDef<z.ZodObject<{ x: z.ZodString }>> = {
      description: "test",
      input: z.object({ x: z.string() }),
      run: (_args, ctx) => ctx,
    };

    type Ctx = Parameters<NonNullable<typeof _t.run>>[1];
    expectTypeOf<Ctx>().toMatchTypeOf<ToolContext>();
  });

  test("ToolContext provides db, env, messages", () => {
    expectTypeOf<ToolContext>().toHaveProperty("db");
    expectTypeOf<ToolContext>().toHaveProperty("env");
    expectTypeOf<ToolContext>().toHaveProperty("messages");
    expectTypeOf<ToolContext["messages"]>().toEqualTypeOf<readonly Message[]>();
    expectTypeOf<ToolContext["env"]>().toEqualTypeOf<Readonly<Record<string, string>>>();
  });
});

describe("AgentDef type inference", () => {
  test("satisfies AgentDef type", () => {
    const agent: AgentDef = { ...baseAgent, name: "test", tools: {} };
    expectTypeOf(agent).toMatchTypeOf<AgentDef>();
  });

  test("typed state flows through to tools", () => {
    type MyState = { counter: number; name: string };

    const _agent: AgentDef<MyState> = {
      ...baseAgent,
      name: "typed-state",
      state: () => ({ counter: 0, name: "test" }),
      tools: {
        inc: {
          description: "Increment",
          run: (_args, ctx) => {
            expectTypeOf(ctx.state).toEqualTypeOf<MyState>();
          },
        },
      },
    };
  });

  test("tools field accepts ToolDef objects", () => {
    const greet: ToolDef<z.ZodObject<{ name: z.ZodString }>> = {
      description: "Greet",
      input: z.object({ name: z.string() }),
      run: ({ name }: { name: string }) => `Hello, ${name}!`,
    };

    const agent: AgentDef = { ...baseAgent, name: "with-tool", tools: { greet } };

    expectTypeOf(agent.tools).toHaveProperty("greet");
  });

  test("required fields are present", () => {
    const agent: AgentDef = { ...baseAgent, name: "defaults", tools: {} };
    expectTypeOf(agent.systemPrompt).toBeString();
    expectTypeOf(agent.greeting).toBeString();
    expectTypeOf(agent.tools).toBeObject();
  });
});
