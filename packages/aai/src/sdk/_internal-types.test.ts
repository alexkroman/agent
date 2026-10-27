// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { z } from "zod";
import { agentToolsToSchemas } from "./_internal-types.ts";
import { sessionSlot } from "./session-slot.ts";
import { type Toolset, toolset } from "./toolset.ts";
import type { ToolDef } from "./types.ts";

/** One `"files"` toolset over a map — what `agentToolsToSchemas` reads. */
const files = (tools: Record<string, ToolDef>): Toolset[] => [toolset("files", tools)];

test("agentToolsToSchemas - converts tool definitions to OpenAI schema", () => {
  const noop = async () => {
    /* no-op */
  };
  const tools: Record<string, ToolDef> = {
    get_weather: {
      description: "Get weather",
      inputSchema: z.object({ city: z.string().describe("City") }),
      execute: noop,
    },
    set_alarm: {
      description: "Set alarm",
      inputSchema: z.object({
        time: z.string(),
        label: z.string().optional(),
      }),
      execute: noop,
    },
  };
  const schemas = agentToolsToSchemas([toolset("files", tools)]);
  expect(schemas.length).toBe(2);
  // `name`/`description` are copied verbatim; `parameters` is the CONVERSION
  // this function is named for, so it is the field worth pinning — including
  // `$schema` being stripped, which some Realtime/S2S providers answer with
  // `args: {}` rather than an error (see `toToolJsonSchema`).
  //
  // No `additionalProperties`, and this fixture used to encode the opposite.
  // The `false` it expected came from converting in zod's `"output"` direction,
  // where it is a true statement about the PARSED value and a false one about
  // what a caller may send: `z.object` accepts an unknown key and drops it. An
  // author who wants it refused writes `z.strictObject`, which keeps the flag —
  // see `toToolJsonSchema`.
  expect(schemas[0]).toEqual({
    type: "function",
    name: "get_weather",
    description: "Get weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City" } },
      required: ["city"],
    },
  });
  expect(schemas[0]?.parameters).not.toHaveProperty("$schema");
  expect(schemas[1]?.name).toBe("set_alarm");
  // The optional field is the one that must NOT be required.
  expect(schemas[1]?.parameters).toMatchObject({ required: ["time"] });
});

// The pipeline's confirmation gate reads `annotations.readOnlyHint` off the wire
// declaration, so an authored write has to carry it there.
test("agentToolsToSchemas - a tool's `annotations` ride the wire declaration", () => {
  const noop = async () => "ok";
  const schemas = agentToolsToSchemas(
    files({
      cancel_order: { description: "Cancel", execute: noop, annotations: { readOnlyHint: false } },
      get_order: { description: "Get", execute: noop, annotations: { readOnlyHint: true } },
      plain: { description: "Plain", execute: noop },
    }),
  );
  expect(schemas.map((one) => one.annotations)).toEqual([
    { readOnlyHint: false },
    { readOnlyHint: true },
    undefined,
  ]);
  expect(schemas[2]).not.toHaveProperty("annotations");
});

// Most template writes are slot tools, whose builder rebuilds the def from the
// fields it knows (`wireFields`). The annotation has to survive that too.
test("agentToolsToSchemas - a slot tool's `annotations` survive its builder", () => {
  const cart = sessionSlot("cart", () => ({ placed: false }));
  const schemas = agentToolsToSchemas(
    files({
      place_order: cart.updateTool({
        description: "Place the order",
        annotations: { readOnlyHint: false },
        execute: (_args, draft) => {
          draft.placed = true;
          return "placed";
        },
      }),
    }),
  );
  expect(schemas[0]?.annotations).toEqual({ readOnlyHint: false });
});

test("agentToolsToSchemas - a tool's `ui` rides the wire declaration, undeclared fields omitted", () => {
  const noop = async () => "ok";
  const schemas = agentToolsToSchemas(
    files({
      add_pizza: { description: "Add", execute: noop, ui: { icon: "🍕", label: "Adding pizza" } },
      lookup: { description: "Look", execute: noop, ui: { label: "Looking up", icon: undefined } },
      plain: { description: "Plain", execute: noop },
      empty: { description: "Empty", execute: noop, ui: {} },
    }),
  );
  expect(schemas.map((one) => one.ui)).toEqual([
    { icon: "🍕", label: "Adding pizza" },
    { label: "Looking up" },
    undefined,
    undefined,
  ]);
  // Omitted, never set to `undefined`: the declaration is what a stored config
  // round-trips through.
  expect(schemas[2]).not.toHaveProperty("ui");
  expect(schemas[3]).not.toHaveProperty("ui");
});

// The surface that decides what an LLM asks the user for. A `.default()` field
// is one the tool would have filled in on its own, so advertising it as
// `required` changes what the model emits — and it is the only one of the three
// conversion surfaces where the mis-description is a prompt.
test("agentToolsToSchemas - a defaulted field is NOT advertised as required", () => {
  const schemas = agentToolsToSchemas(
    files({
      search: {
        description: "Search",
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().default(10),
          page: z.number().optional(),
        }),
        execute: async () => undefined,
      },
    }),
  );
  expect(schemas[0]?.parameters).toMatchObject({ required: ["query"] });
  // The default is still published: the model is told what it gets for free.
  expect(schemas[0]?.parameters).toMatchObject({
    properties: { limit: { default: 10 } },
  });
});

test("agentToolsToSchemas - a tool with no inputSchema gets the empty object schema", () => {
  // `EMPTY_PARAMS`, converted like any other schema. A provider handed a bare
  // `{}` here rejects the tool spec, so the fallback has to be a real JSON
  // Schema rather than an empty record — `type` plus `properties` still is one.
  // `EMPTY_PARAMS` stays a plain `z.object({})` rather than a strict one: a
  // model that decorates a no-arg call with a stray field has that field
  // dropped, where refusing it would fail the turn.
  const schemas = agentToolsToSchemas(
    files({
      ping: { description: "Ping", execute: async () => undefined },
    }),
  );
  expect(schemas[0]?.parameters).toEqual({
    type: "object",
    properties: {},
  });
});

test("agentToolsToSchemas - names the removed `parameters` field rather than shipping a no-arg tool", () => {
  // TypeScript catches the rename for a typed agent; an untypechecked JS one
  // would otherwise deploy a tool the model can only call with no arguments.
  // Typed as the intersection rather than cast: the guard's whole subject is a
  // def carrying the OLD field name, and a widening cast would also stop
  // reporting if `ToolDef` itself changed shape.
  const withOldField: ToolDef & { parameters: unknown } = {
    description: "Get weather",
    parameters: z.object({ city: z.string() }),
    execute: async () => undefined,
  };
  expect(() => agentToolsToSchemas(files({ get_weather: withOldField }))).toThrow(
    /Tool "get_weather" uses the removed `parameters` field — rename it to `inputSchema`\./,
  );
});
