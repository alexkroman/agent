// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for how a roster LOWERS into a `"roster"` toolset — the gate on
 * every speaking entry's own tools, the minted `handoff` the model hands the
 * call off with, and the minted `delegate` it hands a task off with. Driven
 * through `agent({ roster })`, which is the only caller.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "./agent-config.ts";
import { agent, tool } from "./define.ts";
import { DELEGATE_TOOL_NAME, HANDOFF_TOOL_NAME, roster } from "./roster.ts";
import { type ToolInputSchema, toToolJsonSchema } from "./schema.ts";
import { speaker } from "./speaker.ts";
import { createToolContext } from "./testing.ts";
import { stubDelegate } from "./testing-delegate.ts";
import { runTool, toolOf } from "./testing-tools.ts";
import { withTools } from "./tool-registry.ts";
import type { Toolset } from "./toolset.ts";
import type { ToolDef } from "./types.ts";
import { isToolFailure } from "./utils.ts";

const lookupInvoice = tool({
  description: "Look up an invoice",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, total: 42 }),
  messages: { start: ["One moment."] },
});

const triage = speaker({
  name: "triage",
  speaks: true,
  description: "Answers the phone and works out what the caller needs",
  systemPrompt: "Greet the caller and find out whether this is billing or a fault.",
});

const billing = speaker({
  name: "billing",
  speaks: true,
  description: "Invoices, payments and refunds",
  systemPrompt: "You are the billing desk.",
  tools: { lookup_invoice: lookupInvoice },
});

const refunds = speaker({
  name: "refunds",
  description: "Answers billing, invoice and refund questions",
  systemPrompt: "You are the refunds back office.",
});

const tech = speaker({
  name: "tech",
  description: "Diagnoses connection and hardware faults",
  systemPrompt: "You are technical support.",
});

const desk = roster([triage, billing, refunds, tech]);
const frontDesk = agent({ name: "Front Desk", roster: desk });

/** The one toolset `agent()` minted. */
function rosterSet(): Toolset {
  const [set] = frontDesk.toolsets ?? [];
  if (!set) throw new Error("agent() minted no toolset");
  return set;
}

/** A minted tool's def, or a failure naming what was missing. */
function minted(name: string): {
  description: string;
  inputSchema: ToolInputSchema;
  execute: ToolDef["execute"];
} {
  const def = rosterSet().list()[name]?.def;
  if (!def?.inputSchema) throw new Error(`no ${name} tool with an input schema`);
  return { description: def.description, inputSchema: def.inputSchema, execute: def.execute };
}

describe("rosterToolset()", () => {
  it("is every speaking entry's tools plus `handoff` and `delegate`, in one roster toolset", () => {
    expect(rosterSet().source).toBe("roster");
    expect(Object.keys(rosterSet().list()).sort()).toEqual([
      DELEGATE_TOOL_NAME,
      HANDOFF_TOOL_NAME,
      "lookup_invoice",
    ]);
    // The files table stays the files': nothing is minted into `tools`.
    expect(frontDesk.tools).toEqual({});
  });

  it("mints only the routing tool a roster needs", () => {
    const speaking = agent({ name: "x", roster: roster([triage, billing]) }).toolsets?.[0];
    expect(Object.keys(speaking?.list() ?? {}).sort()).toEqual([
      HANDOFF_TOOL_NAME,
      "lookup_invoice",
    ]);
    const offLine = agent({ name: "y", roster: roster([refunds, tech]) }).toolsets?.[0];
    expect(Object.keys(offLine?.list() ?? {})).toEqual([DELEGATE_TOOL_NAME]);
  });

  it("declares no toolset when there is no roster", () => {
    expect(agent({ name: "Plain" }).toolsets).toEqual([]);
  });

  it("is host-only: `toAgentConfig` strips the roster and its toolset", () => {
    const config = toAgentConfig(frontDesk) as Record<string, unknown>;
    expect("roster" in config).toBe(false);
    expect("toolsets" in config).toBe(false);
  });
});

describe("the gate", () => {
  it("refuses a speaking entry's tool while another speaks, with reason `persona`", () => {
    const refused = rosterSet().gate("lookup_invoice", createToolContext());
    expect(refused?.reason).toBe("persona");
    expect(refused?.error).toContain('"lookup_invoice" belongs to the billing persona');
    expect(refused?.error).toContain("triage is speaking");
    expect(refused?.error).toContain(HANDOFF_TOOL_NAME);
  });

  it("passes once its owner is speaking, and never gates the minted tools", () => {
    const ctx = createToolContext();
    expect(rosterSet().gate(HANDOFF_TOOL_NAME, ctx)).toBeUndefined();
    desk.handoff(ctx, billing);
    expect(rosterSet().gate("lookup_invoice", ctx)).toBeUndefined();
  });

  it("is what a spec meets through `runTool` by name — the tool as a call reaches it", async () => {
    const ctx = createToolContext();
    const refused = await runTool(frontDesk, "lookup_invoice", { id: "INV-1" }, ctx);
    expect(isToolFailure(refused)).toBe(true);
    expect(refused).toMatchObject({ reason: "persona" });
    // `toolOf` is the LOOKUP: the author's own def, ungated.
    expect(toolOf(frontDesk, "lookup_invoice")).toBe(lookupInvoice);
    desk.handoff(ctx, billing);
    expect(await runTool(frontDesk, "lookup_invoice", { id: "INV-1" }, ctx)).toEqual({
      id: "INV-1",
      total: 42,
    });
  });

  it("leaves the def as the author wrote it — the gate is the toolset's, not a wrapper", () => {
    expect(rosterSet().list().lookup_invoice?.def).toBe(lookupInvoice);
  });
});

describe("the minted `handoff` tool", () => {
  it("takes a speaking entry as an enum, and an optional note", () => {
    const schema = toToolJsonSchema(minted(HANDOFF_TOOL_NAME).inputSchema) as {
      properties: { persona: { enum: string[] }; note: unknown };
      required?: string[];
    };
    expect(schema.properties.persona.enum).toEqual(["triage", "billing"]);
    expect(schema.required).toEqual(["persona"]);
  });

  it("renders each speaking entry's description into its own", () => {
    const { description } = minted(HANDOFF_TOOL_NAME);
    expect(description).toContain("- triage: Answers the phone");
    expect(description).toContain("- billing: Invoices, payments and refunds");
    expect(description).not.toContain("- tech:");
  });

  it("hands off and returns the handoff result the model reads", async () => {
    const ctx = createToolContext();
    const result = await minted(HANDOFF_TOOL_NAME).execute(
      { persona: "billing", note: "VIP" },
      ctx,
    );
    expect(result).toMatchObject({ handoff: true, from: "triage", to: "billing", note: "VIP" });
    expect(desk.active(ctx)).toBe(billing);
  });

  it("turns an off-roster name into a refusal the model can read, not a throw", async () => {
    const result = await minted(HANDOFF_TOOL_NAME).execute(
      { persona: "tech" },
      createToolContext(),
    );
    expect(result).toMatchObject({ reason: "roster" });
  });
});

describe("the minted `delegate` tool", () => {
  it("makes the subagent argument an enum over the entries that run off the line", () => {
    const schema = toToolJsonSchema(minted(DELEGATE_TOOL_NAME).inputSchema);
    const chosen = (schema.properties as Record<string, { enum?: string[] }>).subagent;
    expect(chosen?.enum).toEqual(["refunds", "tech"]);
    expect(schema.required).toEqual(["subagent", "task"]);
  });

  it("tells the model what each one is FOR, not just its name", () => {
    const { description } = minted(DELEGATE_TOOL_NAME);
    expect(description).toContain("- refunds: Answers billing, invoice and refund");
    expect(description).toContain("- tech: Diagnoses connection and hardware faults");
    expect(description).not.toContain("- billing:");
  });

  it("routes the task to the speaker the model named, with the whole brief", async () => {
    const model = stubDelegate({
      routes: { refunds: "Refunded on the 3rd.", tech: "Reboot the modem." },
    });
    const result = await minted(DELEGATE_TOOL_NAME).execute(
      { subagent: "refunds", task: "Was invoice 41 refunded?", context: "Account 900." },
      createToolContext({ delegate: model.delegate }),
    );
    expect(result).toEqual({ subagent: "refunds", answer: "Refunded on the 3rd.", lookups: 0 });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.subagent.name).toBe("refunds");
    expect(model.calls[0]?.task).toBe("Was invoice 41 refunded?");
    expect(model.calls[0]?.options.context).toBe("Account 900.");
  });

  it("reports the lookups a run made, so the agent can narrate the wait", async () => {
    const model = stubDelegate({
      routes: {
        tech: { text: "Reboot the modem.", toolCalls: [{ name: "kb_search", input: {} }] },
      },
    });
    const result = await minted(DELEGATE_TOOL_NAME).execute(
      { subagent: "tech", task: "No sync light." },
      createToolContext({ delegate: model.delegate }),
    );
    expect(result).toMatchObject({ lookups: 1 });
  });

  it("surfaces an answer the speaker's own guardrail never accepted", async () => {
    const model = stubDelegate({
      routes: { tech: { text: "Try turning it off.", complaint: "No diagnostic step was run." } },
    });
    const result = await minted(DELEGATE_TOOL_NAME).execute(
      { subagent: "tech", task: "No sync light." },
      createToolContext({ delegate: model.delegate }),
    );
    expect(result).toMatchObject({
      answer: "Try turning it off.",
      unverified: "No diagnostic step was run.",
    });
  });

  it("refuses a name the roster does not delegate to, with reason `roster`", async () => {
    const model = stubDelegate({ routes: { refunds: "x" } });
    const result = await minted(DELEGATE_TOOL_NAME).execute(
      { subagent: "billing", task: "Where is it?" },
      createToolContext({ delegate: model.delegate }),
    );
    expect(result).toEqual({
      error: 'There is no speaker called "billing". Available: refunds, tech.',
      reason: "roster",
    });
    expect(model.calls).toEqual([]);
  });
});

describe("collisions", () => {
  it("a `tools/` file colliding with a minted or speaking-entry tool names the roster", () => {
    for (const name of [HANDOFF_TOOL_NAME, DELEGATE_TOOL_NAME, "lookup_invoice"]) {
      expect(
        () => withTools(frontDesk, { [name]: { description: "x", execute: () => "x" } }),
        name,
      ).toThrow(/collides with a tool this agent's roster already declares/);
    }
  });

  it("still reports an ordinary double declaration when there is no roster", () => {
    const plain = {
      ...agent({ name: "Plain" }),
      tools: { echo: tool({ description: "d", execute: () => "x" }) },
    };
    expect(() =>
      withTools(plain, { echo: tool({ description: "d", execute: () => "x" }) }),
    ).toThrow(/The tool "echo" is declared twice/);
  });
});
