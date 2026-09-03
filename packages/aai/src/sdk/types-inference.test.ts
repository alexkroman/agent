// Copyright 2025 the AAI authors. MIT license.
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { sessionSlot } from "./session-slot.ts";
import type { AgentDef, Message, ToolContext, ToolDef } from "./types.ts";

const baseAgent = {
  systemPrompt: "Be helpful.",
  greeting: "Hello!",
  maxSteps: 5,
} as const;

describe("ToolDef type inference", () => {
  test("infers parameter types in execute args", () => {
    const _t: ToolDef<z.ZodObject<{ name: z.ZodString; count: z.ZodNumber }>> = {
      description: "test",
      inputSchema: z.object({ name: z.string(), count: z.number() }),
      execute: (args) => args,
    };

    type Args = Parameters<typeof _t.execute>[0];
    expectTypeOf<Args>().toEqualTypeOf<{ name: string; count: number }>();
  });

  test("ToolDef without parameters has unknown args", () => {
    const _t: ToolDef = {
      description: "test",
      execute: (args) => args,
    };

    type Args = Parameters<typeof _t.execute>[0];
    expectTypeOf<Args>().toBeObject();
  });

  test("execute receives ToolContext as second arg", () => {
    const _t: ToolDef<z.ZodObject<{ x: z.ZodString }>> = {
      description: "test",
      inputSchema: z.object({ x: z.string() }),
      execute: (_args, ctx) => ctx,
    };

    type Ctx = Parameters<typeof _t.execute>[1];
    expectTypeOf<Ctx>().toMatchTypeOf<ToolContext>();
  });

  test("ToolContext provides env and messages, and NO db", () => {
    // `db` was here. It is gone with `ctx.db`, and the absence is pinned at the
    // type level so a tool written against the old API fails to COMPILE rather
    // than at run time. `.not` rather than an expect-error suppression comment:
    // `check:hatches` counts those (and counts them in PROSE too, which is how
    // this note came to be worded around it), and a suppression would also pass
    // for the wrong reason if the line stopped erroring for an unrelated cause.
    expectTypeOf<ToolContext>().not.toHaveProperty("db");
    expectTypeOf<ToolContext>().toHaveProperty("env");
    expectTypeOf<ToolContext>().toHaveProperty("messages");
    expectTypeOf<ToolContext["messages"]>().toEqualTypeOf<readonly Message[]>();
    // `Partial`, so a read is `string | undefined`. Pinned because the value it
    // protects is a credential: typed `string`, `ctx.env.NEVER_SET` compiled,
    // built, deployed, and threw a `TypeError` on the first live call — which
    // reaches the caller as the agent apologising. Widening this back is that
    // bug returning, so it fails here rather than in someone's phone call.
    expectTypeOf<ToolContext["env"]>().toEqualTypeOf<Readonly<Partial<Record<string, string>>>>();
  });
});

describe("AgentDef type inference", () => {
  test("satisfies AgentDef type", () => {
    const agent: AgentDef = { ...baseAgent, name: "test", tools: {} };
    expectTypeOf(agent).toMatchTypeOf<AgentDef>();
  });

  test("a slot types the state a tool reads, with no annotation anywhere", () => {
    type MyState = { counter: number; name: string };
    const slot = sessionSlot("typed", (): MyState => ({ counter: 0, name: "test" }));

    const _agent: AgentDef = {
      ...baseAgent,
      name: "typed-state",
      tools: {
        inc: {
          description: "Increment",
          execute: (_args, ctx) => {
            expectTypeOf(slot.get(ctx)).toEqualTypeOf<Readonly<MyState>>();
            slot.update(ctx, (state) => {
              expectTypeOf(state).toEqualTypeOf<MyState>();
              state.counter += 1;
            });
          },
        },
      },
    };
    expectTypeOf(_agent).toMatchTypeOf<AgentDef>();
  });

  test("tools field accepts ToolDef objects", () => {
    const greet: ToolDef<z.ZodObject<{ name: z.ZodString }>> = {
      description: "Greet",
      inputSchema: z.object({ name: z.string() }),
      execute: ({ name }: { name: string }) => `Hello, ${name}!`,
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
