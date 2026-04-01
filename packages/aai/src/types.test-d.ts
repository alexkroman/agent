// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the internal types of @alexkroman1/aai.
 *
 * These are checked by tsc (via vitest typecheck) but never executed.
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
  BuiltinTool,
  JSONSchemaObject,
  Message,
  ToolChoice,
  ToolDef,
  ToolResultMap,
} from "./index.ts";
import type { Kv, KvEntry, KvListOptions } from "./isolate/kv.ts";

// ─── ToolDef ─────────────────────────────────────────────────────────────

describe("ToolDef", () => {
  it("accepts JSON Schema parameters", () => {
    const t: ToolDef = {
      description: "greet",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<Record<string, unknown>>();
        return `Hello, ${args.name}`;
      },
    };
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });

  it("works without parameters", () => {
    const t: ToolDef = {
      description: "ping",
      execute: () => "pong",
    };
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });

  it("provides ToolContext to execute", () => {
    const _t: ToolDef = {
      description: "test",
      execute: (_args, ctx) => {
        expectTypeOf(ctx.env).toEqualTypeOf<Readonly<Record<string, string>>>();
        expectTypeOf(ctx.kv).toEqualTypeOf<Kv>();
        expectTypeOf(ctx.messages).toEqualTypeOf<readonly Message[]>();
        expectTypeOf(ctx.fetch).toEqualTypeOf<typeof globalThis.fetch>();
        expectTypeOf(ctx.sessionId).toEqualTypeOf<string>();
      },
    };
  });

  it("allows async execute", () => {
    const t: ToolDef = {
      description: "async",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const res = await ctx.fetch(args.url as string);
        return res.json();
      },
    };
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });
});

// ─── JSONSchemaObject ────────────────────────────────────────────────────

describe("JSONSchemaObject", () => {
  it("requires type: object", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    expectTypeOf(schema.type).toEqualTypeOf<"object">();
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
    expectTypeOf<ToolChoice>().toEqualTypeOf<
      "auto" | "required" | "none" | { type: "tool"; toolName: string }
    >();
  });

  it("ToolResultMap passes through its generic", () => {
    type MyResults = ToolResultMap<{ add: { id: number }; remove: { ok: boolean } }>;
    expectTypeOf<MyResults>().toEqualTypeOf<{ add: { id: number }; remove: { ok: boolean } }>();
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
