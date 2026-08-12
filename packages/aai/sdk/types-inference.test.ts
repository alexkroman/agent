// Copyright 2025 the AAI authors. MIT license.
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type {
  AgentContext,
  AgentDef,
  InferToolInput,
  Message,
  ToolContext,
  ToolDef,
} from "./types.ts";
import type { WorkflowContext } from "./workflow.ts";

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

    type Ctx = Parameters<typeof _t.run>[1];
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

describe("AgentContext is the surface a tool and a workflow share", () => {
  test("both contexts satisfy it, so a helper typed against it takes either", () => {
    // This is the whole content of "one context": the shared half is a type you
    // can name and pass. Asserted from BOTH sides — either context drifting off
    // the base (a renamed field, a narrowed `db`) breaks a helper that compiles
    // today, and nothing else would report it.
    expectTypeOf<ToolContext>().toExtend<AgentContext>();
    expectTypeOf<WorkflowContext>().toExtend<AgentContext>();
  });

  test("the base carries exactly the four capabilities, and no session or durable ones", () => {
    // The omissions are the design (see AgentContext's own doc): `step` on a tool
    // context would make an exactly-once helper silently at-least-once, and
    // `state`/`send` mean nothing in a run that outlives its session. A field
    // added to the base is a claim that BOTH sides really provide it, so the list
    // is pinned rather than spot-checked.
    expectTypeOf<keyof AgentContext>().toEqualTypeOf<"env" | "db" | "generate" | "signal">();
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
