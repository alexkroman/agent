// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  type AgentConfig,
  AgentConfigSchema,
  agentToolsToSchemas,
  type HostOnlyAgentField,
  toAgentConfig,
} from "./_internal-types.ts";
import type { AgentDef, ToolDef } from "./types.ts";

// The single subtraction the config-mapping design rests on: every AgentDef
// field must be either serializable (present in AgentConfigSchema) or named
// in HOST_ONLY_AGENT_FIELDS. A field added to AgentDef alone fails here
// instead of silently vanishing at the serialization boundary.
test("every AgentDef field is serialized or explicitly host-only", () => {
  type Dropped = Exclude<keyof AgentDef, keyof AgentConfig | HostOnlyAgentField>;
  expectTypeOf<Dropped>().toEqualTypeOf<never>();
});

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
  const schemas = agentToolsToSchemas(tools);
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

// The surface that decides what an LLM asks the user for. A `.default()` field
// is one the tool would have filled in on its own, so advertising it as
// `required` changes what the model emits — and it is the only one of the three
// conversion surfaces where the mis-description is a prompt.
test("agentToolsToSchemas - a defaulted field is NOT advertised as required", () => {
  const schemas = agentToolsToSchemas({
    search: {
      description: "Search",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().default(10),
        page: z.number().optional(),
      }),
      execute: async () => undefined,
    },
  });
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
  const schemas = agentToolsToSchemas({
    ping: { description: "Ping", execute: async () => undefined },
  });
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
  expect(() => agentToolsToSchemas({ get_weather: withOldField })).toThrow(
    /Tool "get_weather" uses the removed `parameters` field — rename it to `inputSchema`\./,
  );
});

/**
 * `toAgentConfig` over a RAW record — one seam rather than a laundering cast per
 * assertion. `AgentConfigSource` `Omit`s `mode` precisely so a typed caller
 * cannot supply one, and these tests cover what the runtime does when a raw
 * object (a hand-written `export default {...}`, or a config round-tripped
 * through the wire) carries one anyway.
 */
function rawConfig(fields: Record<string, unknown>): AgentConfig {
  return toAgentConfig(fields as never);
}

describe("AgentConfigSchema", () => {
  const base = { name: "a", systemPrompt: "p", greeting: "g" };

  test("accepts minBargeInWords above 1", () => {
    expect(AgentConfigSchema.safeParse({ ...base, minBargeInWords: 5 }).success).toBe(true);
  });

  test("rejects minBargeInWords below 1", () => {
    expect(AgentConfigSchema.safeParse({ ...base, minBargeInWords: 0 }).success).toBe(false);
  });

  test.each(["s2s", "pipeline"] as const)("accepts mode: %s", (mode) => {
    expect(AgentConfigSchema.safeParse({ ...base, mode }).success).toBe(true);
  });

  test("rejects unknown mode", () => {
    expect(AgentConfigSchema.safeParse({ ...base, mode: "hybrid" }).success).toBe(false);
  });
});

describe("toAgentConfig", () => {
  const base = { name: "a", systemPrompt: "p", greeting: "g" };
  const desc = (kind: string) => ({ kind, options: {} });

  test("omits every optional field that is unset (no undefined-valued keys)", () => {
    // A source with no providers gets the default AssemblyAI pipeline
    // injected; pin to S2S so this test stays about unset-field omission.
    const config = toAgentConfig({ ...base, s2s: desc("assemblyai") });
    expect(config).toEqual({ ...base, s2s: desc("assemblyai"), mode: "s2s" });
    // `toEqual` treats a present-but-undefined key as absent, so check key
    // presence explicitly — the config crosses a structured-clone/JSON
    // boundary where phantom keys are visible.
    expect(Object.keys(config).sort()).toEqual(["greeting", "mode", "name", "s2s", "systemPrompt"]);
  });

  test("injects the default AssemblyAI pipeline when no providers are declared", () => {
    const config = toAgentConfig(base);
    expect(config.mode).toBe("pipeline");
    expect(config.stt?.kind).toBe("assemblyai");
    expect(config.llm?.kind).toBe("assemblyai");
    expect(config.tts?.kind).toBe("assemblyai");
    expect(config.s2s).toBeUndefined();
  });

  test("propagates every optional field in pipeline mode", () => {
    const src = {
      ...base,
      sttPrompt: "domain terms",
      maxSteps: 7,
      toolChoice: "required" as const,
      builtinTools: ["think"] as const,
      idleTimeoutMs: 1000,
      silenceTimeoutMs: 9000,
      silencePrompt: "nudge",
      minBargeInWords: 3,
      interruptionMinDurationMs: 250,
      deadAirCoverMs: 2500,
      resumeFalseInterruption: true,
      stt: desc("assemblyai"),
      llm: desc("anthropic"),
      tts: desc("cartesia"),
    };
    expect(toAgentConfig(src)).toEqual({ ...src, mode: "pipeline" });
  });

  test("propagates the s2s descriptor and keeps the pipeline triple absent", () => {
    const config = toAgentConfig({ ...base, s2s: desc("assemblyai") });
    expect(config.mode).toBe("s2s");
    expect(config.s2s).toEqual(desc("assemblyai"));
    expect("stt" in config).toBe(false);
    expect("llm" in config).toBe(false);
    expect("tts" in config).toBe(false);
  });

  test("a `mode` on the SOURCE cannot overwrite the derived one", () => {
    // `AgentConfigSource` omits `mode` precisely so a typed caller cannot
    // supply one — but the copy is a deny-list over `Object.entries`, so a raw
    // `export default {...}` or a config round-tripped through the wire reaches
    // it anyway. The derived value is the authority; `IsolateConfigSchema`'s
    // `superRefine` would otherwise reject the disagreement at deploy time,
    // which reads as a confusing deploy failure rather than as this.
    const config = rawConfig({ ...base, s2s: desc("assemblyai"), mode: "pipeline" });
    expect(config.mode).toBe("s2s");
  });

  test("…in the other direction too", () => {
    const config = rawConfig({ ...base, mode: "s2s" });
    expect(config.mode).toBe("pipeline");
  });
});
