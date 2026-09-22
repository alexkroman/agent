// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for how a roster LOWERS into the agent's tool table — the gate
 * around every persona's own tools, and the minted `handoff` tool the model
 * routes with. Driven through `agent({ personas })`, which is the only caller.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "./agent-config.ts";
import { agent, tool } from "./define.ts";
import { HANDOFF_TOOL_NAME, persona, personas } from "./persona.ts";
import { personaTools } from "./persona-roster.ts";
import { type ToolInputSchema, toToolJsonSchema } from "./schema.ts";
import { createToolContext } from "./testing.ts";
import { withTools } from "./tool-registry.ts";
import type { ToolDef } from "./types.ts";
import { isToolFailure } from "./utils.ts";

const lookupInvoice = tool({
  description: "Look up an invoice",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, total: 42 }),
  messages: { start: ["One moment."] },
});

const triage = persona({
  name: "triage",
  description: "Answers the phone and works out what the caller needs",
  systemPrompt: "Greet the caller and find out whether this is billing or a fault.",
});

const billing = persona({
  name: "billing",
  description: "Invoices, payments and refunds",
  systemPrompt: "You are the billing desk.",
  tools: { lookup_invoice: lookupInvoice },
});

const desk = personas([triage, billing]);
const frontDesk = agent({ name: "Front Desk", personas: desk });

/** The minted tool, or a failure naming what was missing — see the subagent roster spec. */
function handoffTool(def: { tools: Readonly<Record<string, ToolDef>> }): {
  description: string;
  inputSchema: ToolInputSchema;
  execute: ToolDef["execute"];
} {
  const minted = def.tools[HANDOFF_TOOL_NAME];
  if (!minted?.inputSchema) throw new Error(`no ${HANDOFF_TOOL_NAME} tool with an input schema`);
  return {
    description: minted.description,
    inputSchema: minted.inputSchema,
    execute: minted.execute,
  };
}

describe("personaTools()", () => {
  it("is every persona's tools plus `handoff`, and is what `agent()` puts in the table", () => {
    expect(Object.keys(personaTools(desk)).sort()).toEqual(["handoff", "lookup_invoice"]);
    expect(Object.keys(frontDesk.tools).sort()).toEqual(["handoff", "lookup_invoice"]);
  });

  it("is host-only: `toAgentConfig` strips the roster", () => {
    expect("personas" in toAgentConfig(frontDesk)).toBe(false);
  });
});

describe("the gate", () => {
  it("refuses a persona's tool while another speaks, naming who is and how to hand off", async () => {
    const ctx = createToolContext();
    const refused = await frontDesk.tools.lookup_invoice?.execute({ id: "INV-1" }, ctx);
    if (!isToolFailure(refused)) throw new Error("expected a refusal");
    expect(refused.error).toContain("belongs to the billing persona");
    expect(refused.error).toContain("triage is speaking");
    expect(refused.error).toContain(HANDOFF_TOOL_NAME);
  });

  it("runs the tool once its owner is speaking", async () => {
    const ctx = createToolContext();
    desk.handoff(ctx, billing);
    expect(await frontDesk.tools.lookup_invoice?.execute({ id: "INV-1" }, ctx)).toEqual({
      id: "INV-1",
      total: 42,
    });
  });

  it("leaves everything but `execute` as the author wrote it", () => {
    const gated = frontDesk.tools.lookup_invoice;
    expect(gated?.description).toBe("Look up an invoice");
    expect(gated?.inputSchema).toBe(lookupInvoice.inputSchema);
    expect(gated?.messages).toBe(lookupInvoice.messages);
  });
});

describe("the minted `handoff` tool", () => {
  it("takes the persona as an enum over the roster's names, and an optional note", () => {
    const schema = toToolJsonSchema(handoffTool(frontDesk).inputSchema) as {
      properties: { persona: { enum: string[] }; note: unknown };
      required?: string[];
    };
    expect(schema.properties.persona.enum).toEqual(["triage", "billing"]);
    expect(schema.required).toEqual(["persona"]);
  });

  it("renders each persona's description into its own — the whole routing decision", () => {
    const { description } = handoffTool(frontDesk);
    expect(description).toContain("- triage: Answers the phone");
    expect(description).toContain("- billing: Invoices, payments and refunds");
  });

  it("hands off and returns the handoff result the model reads", async () => {
    const ctx = createToolContext();
    const result = await handoffTool(frontDesk).execute({ persona: "billing", note: "VIP" }, ctx);
    expect(result).toMatchObject({ handoff: true, from: "triage", to: "billing", note: "VIP" });
    expect(desk.active(ctx)).toBe(billing);
  });

  it("turns an off-roster name into a failure the model can read, not a throw", async () => {
    // The enum makes this unreachable through a compliant provider; a repaired
    // call can still carry it, and the failure to avoid is a throw out of the
    // tool loop.
    const result = await handoffTool(frontDesk).execute(
      { persona: "shipping" },
      createToolContext(),
    );
    expect(isToolFailure(result)).toBe(true);
  });
});

describe("collisions", () => {
  it("a `tools/` file colliding with a persona's tool or the minted one names `personas`", () => {
    expect(() =>
      withTools(frontDesk, {
        [HANDOFF_TOOL_NAME]: { description: "x", execute: () => "x" },
      }),
    ).toThrow(/`personas` is what puts one there/);
    expect(() =>
      withTools(frontDesk, { lookup_invoice: { description: "x", execute: () => "x" } }),
    ).toThrow(/`personas` is what puts one there/);
  });
});
