// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the public API surface of @alexkroman1/aai.
 *
 * These are checked by tsc (via vitest typecheck) but never executed.
 * A failure here means a public type contract has regressed.
 */

import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type AgentServer, createRuntime, createServer, type Runtime } from "./host/server.ts";
import {
  type AgentDef,
  type BuiltinTool,
  defineAgent,
  defineTool,
  defineToolFactory,
  type HookContext,
  type Kv,
  type KvEntry,
  type KvListOptions,
  type Message,
  type ToolChoice,
  type ToolContext,
  type ToolDef,
  type ToolResultMap,
} from "./index.ts";

// ─── defineAgent ──────────────────────────────────────────────────────────

describe("defineAgent", () => {
  it("accepts minimal options and returns AgentDef", () => {
    const agent = defineAgent({ name: "test" });
    expectTypeOf(agent).toEqualTypeOf<AgentDef<Record<string, unknown>>>();
  });

  it("infers state generic from options", () => {
    interface MyState {
      count: number;
    }
    const agent = defineAgent<MyState>({
      name: "test",
      state: () => ({ count: 0 }),
      onConnect: (ctx) => {
        expectTypeOf(ctx.state).toEqualTypeOf<MyState>();
      },
    });
    expectTypeOf(agent).toEqualTypeOf<AgentDef<MyState>>();
  });

  it("requires name to be a string", () => {
    // @ts-expect-error — name must be a string
    defineAgent({ name: 123 });
  });

  it("requires name property", () => {
    // @ts-expect-error — name is required
    defineAgent({});
  });

  it("rejects unknown options", () => {
    // @ts-expect-error — unknown property
    defineAgent({ name: "test", unknownProp: true });
  });

  it("types hooks with correct state parameter", () => {
    defineAgent<{ userId: string }>({
      name: "test",
      state: () => ({ userId: "abc" }),
      onConnect: (ctx) => {
        expectTypeOf(ctx.state).toEqualTypeOf<{ userId: string }>();
        expectTypeOf(ctx.env).toEqualTypeOf<Readonly<Record<string, string>>>();
        expectTypeOf(ctx.kv).toEqualTypeOf<Kv>();
        expectTypeOf(ctx.sessionId).toEqualTypeOf<string>();
      },
      onDisconnect: (ctx) => {
        expectTypeOf(ctx.state).toEqualTypeOf<{ userId: string }>();
      },
      onTurn: (text, ctx) => {
        expectTypeOf(text).toEqualTypeOf<string>();
        expectTypeOf(ctx.state).toEqualTypeOf<{ userId: string }>();
      },
    });
  });

  it("accepts all BuiltinTool values", () => {
    defineAgent({
      name: "test",
      builtinTools: ["web_search", "visit_webpage", "fetch_json", "run_code"],
    });
  });

  it("rejects invalid builtin tool names", () => {
    defineAgent({
      name: "test",
      // @ts-expect-error — invalid builtin tool
      builtinTools: ["not_a_tool"],
    });
  });

  it("accepts all ToolChoice values", () => {
    defineAgent({ name: "a", toolChoice: "auto" });
    defineAgent({ name: "b", toolChoice: "required" });
  });
});

// ─── defineTool ───────────────────────────────────────────────────────────

describe("defineTool", () => {
  it("infers parameter types from Zod schema", () => {
    const t = defineTool({
      description: "greet",
      parameters: z.object({ name: z.string() }),
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ name: string }>();
        return `Hello, ${args.name}`;
      },
    });
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });

  it("works without parameters", () => {
    const t = defineTool({
      description: "ping",
      execute: () => "pong",
    });
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });

  it("provides ToolContext to execute", () => {
    defineTool({
      description: "test",
      parameters: z.object({}),
      execute: (_args, ctx) => {
        expectTypeOf(ctx.env).toEqualTypeOf<Readonly<Record<string, string>>>();
        expectTypeOf(ctx.kv).toEqualTypeOf<Kv>();
        expectTypeOf(ctx.messages).toEqualTypeOf<readonly Message[]>();
        expectTypeOf(ctx.sessionId).toEqualTypeOf<string>();
      },
    });
  });

  it("allows async execute", () => {
    const t = defineTool({
      description: "async",
      parameters: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        const res = await fetch(url);
        return res.json();
      },
    });
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });
});

// ─── defineToolFactory ────────────────────────────────────────────────────

describe("defineToolFactory", () => {
  it("returns a typed defineTool variant", () => {
    interface AppState {
      items: string[];
    }
    const typedTool = defineToolFactory<AppState>();

    typedTool({
      description: "add item",
      parameters: z.object({ item: z.string() }),
      execute: (args, ctx) => {
        expectTypeOf(ctx.state).toEqualTypeOf<AppState>();
        ctx.state.items.push(args.item);
      },
    });
  });
});

// ─── createServer ─────────────────────────────────────────────────────────

describe("createRuntime", () => {
  it("accepts RuntimeOptions and returns Runtime", () => {
    const agent = defineAgent({ name: "test" });
    const runtime = createRuntime({ agent, env: {} });
    expectTypeOf(runtime).toMatchTypeOf<Runtime>();
    expectTypeOf(runtime.startSession).toBeFunction();
    expectTypeOf(runtime.shutdown).toEqualTypeOf<() => Promise<void>>();
  });
});

describe("createServer", () => {
  it("accepts ServerOptions with runtime and returns AgentServer", () => {
    const agent = defineAgent({ name: "test" });
    const runtime = createRuntime({ agent, env: {} });
    const server = createServer({ runtime });
    expectTypeOf(server).toEqualTypeOf<AgentServer>();
    expectTypeOf(server.listen).toEqualTypeOf<(port?: number) => Promise<void>>();
    expectTypeOf(server.close).toEqualTypeOf<() => Promise<void>>();
    expectTypeOf(server.port).toEqualTypeOf<number | undefined>();
  });

  it("requires runtime in options", () => {
    // @ts-expect-error — runtime is required
    createServer({});
  });
});

// ─── Key types exist and have expected shapes ─────────────────────────────

describe("exported types", () => {
  it("Message has expected shape", () => {
    expectTypeOf<Message>().toEqualTypeOf<{
      role: "user" | "assistant" | "tool";
      content: string;
    }>();
  });

  it("BuiltinTool is a union of known tool names", () => {
    expectTypeOf<BuiltinTool>().toEqualTypeOf<
      "web_search" | "visit_webpage" | "fetch_json" | "run_code"
    >();
  });

  it("ToolChoice includes all variants", () => {
    expectTypeOf<ToolChoice>().toEqualTypeOf<"auto" | "required">();
  });

  it("ToolResultMap passes through its generic", () => {
    type MyResults = ToolResultMap<{ add: { id: number }; remove: { ok: boolean } }>;
    expectTypeOf<MyResults>().toEqualTypeOf<{ add: { id: number }; remove: { ok: boolean } }>();
  });

  it("HookContext extends ToolContext fields (minus messages) with per-hook data", () => {
    type HC = HookContext<{ x: number }>;
    type TC = ToolContext<{ x: number }>;
    // HookContext has all ToolContext fields except messages
    expectTypeOf<HC["env"]>().toEqualTypeOf<TC["env"]>();
    expectTypeOf<HC["state"]>().toEqualTypeOf<TC["state"]>();
    expectTypeOf<HC["kv"]>().toEqualTypeOf<TC["kv"]>();
    expectTypeOf<HC["sessionId"]>().toEqualTypeOf<TC["sessionId"]>();
  });

  it("KvEntry has expected shape", () => {
    expectTypeOf<KvEntry<string>>().toEqualTypeOf<{ key: string; value: string }>();
  });

  it("KvListOptions has expected shape", () => {
    expectTypeOf<KvListOptions>().toEqualTypeOf<{
      limit?: number;
      reverse?: boolean;
    }>();
  });
});
