// Copyright 2026 the AAI authors. MIT license.
// The one door from the runtime — and specifically the THREE answers it gives,
// because honouring one and forgetting another is the failure mode the single
// return exists to prevent. UNIT tier.

import type { AgentDef, BuiltinTool, TwoTierConfig } from "@alexkroman1/aai";
import { agent } from "@alexkroman1/aai";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { consoleLogger } from "../runtime-config.ts";
import { createUsageMeter } from "../usage-meter.ts";
import { type CreateTwoTierOpenerDeps, createTwoTierWiring } from "./wire.ts";

const SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    name: "change_address",
    description: "Change an address",
    parameters: { type: "object", properties: {} },
    mutates: true,
  },
];

const surface = {
  toolSchemas: SCHEMAS,
  executeTool: () => Promise.resolve("{}"),
};

function deps(
  over: { twoTier?: TwoTierConfig; builtinTools?: readonly BuiltinTool[] } = {},
): CreateTwoTierOpenerDeps {
  // Through `agent()` rather than an object literal, so the declaration this
  // reads is the one an author's `agent.ts` produces.
  const def: AgentDef = agent({ name: "Desk", ...over });
  return {
    agent: def,
    llm: { kind: "assemblyai", options: { model: "gpt-5.5" } },
    providerEnv: { ASSEMBLYAI_API_KEY: "k" },
    logger: consoleLogger,
  };
}

describe("createTwoTierWiring", () => {
  test("no declaration: no opener, the agent's OWN tools, and tool guidance ON", () => {
    // The whole off-switch. Everything downstream gates on `open`, and these
    // two answers are what "behaves exactly as it did" means concretely.
    const wiring = createTwoTierWiring(deps(), surface);
    expect(wiring.open).toBeUndefined();
    expect(wiring.fastToolSchemas).toBe(SCHEMAS);
    expect(wiring.fastHasTools).toBe(true);
  });

  test("no declaration and no tools: guidance OFF, which was already true", () => {
    const wiring = createTwoTierWiring(deps(), { ...surface, toolSchemas: [] });
    expect(wiring.fastHasTools).toBe(false);
  });

  test("a BUILTIN counts as a tool for the guidance answer", () => {
    const wiring = createTwoTierWiring(deps({ builtinTools: ["think"] }), {
      ...surface,
      toolSchemas: [],
    });
    expect(wiring.fastHasTools).toBe(true);
  });

  test("declared: an opener, NO tools for the fast tier, and guidance OFF", () => {
    // `fastToolSchemas: []` IS the mutation gate — the request carries no tool
    // list, so the conversational model cannot change anything whatever it
    // decides to do. `fastHasTools: false` is its necessary companion: tool
    // guidance would describe a surface that is not there.
    const wiring = createTwoTierWiring(deps({ twoTier: {} }), surface);
    expect(wiring.open).toBeTypeOf("function");
    expect(wiring.fastToolSchemas).toEqual([]);
    expect(wiring.fastHasTools).toBe(false);
  });

  test("declared WITH builtins: still no tools and still no guidance", () => {
    // The arm a `??`-chained implementation gets wrong: a declared builtin is
    // the agent's, and the fast tier does not get it either.
    const wiring = createTwoTierWiring(deps({ twoTier: {}, builtinTools: ["think"] }), surface);
    expect(wiring.fastToolSchemas).toEqual([]);
    expect(wiring.fastHasTools).toBe(false);
  });

  test("the opener builds a session whose surface is the AGENT's tools plus the channel", () => {
    const wiring = createTwoTierWiring(deps({ twoTier: {} }), surface);
    const session = wiring.open?.({
      sessionId: "s1",
      usage: createUsageMeter({ limits: undefined }),
      transport: () => ({}),
      instructions: () => "i",
    });
    expect(session?.schemas.map((s) => s.name)).toEqual([
      "change_address",
      "tell_user",
      "ask_user",
      "task_done",
    ]);
    session?.stop();
  });
});
