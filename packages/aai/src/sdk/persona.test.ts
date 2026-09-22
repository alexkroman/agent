// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `personas()` — the roster's refusals, the handoff and what it
 * returns, and a dialog state's `persona` pin. The lowering into the agent's
 * tool table (the gate and the minted `handoff` tool) is `persona-roster.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import { dialog } from "./dialog.ts";
import { HANDOFF_TOOL_NAME, type PersonaDef, persona, personas } from "./persona.ts";
import { createToolContext } from "./testing.ts";

const lookupInvoice = tool({
  description: "Look up an invoice",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, total: 42 }),
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
  toolChoice: "required",
  temperature: 0.2,
});

const desk = personas([triage, billing]);

describe("personas()", () => {
  it("answers as the first entry until a handoff", () => {
    const ctx = createToolContext();
    expect(desk.active(ctx).name).toBe("triage");
    expect(desk.position(ctx)).toEqual({ persona: triage });
  });

  it("hands off, records who from and the note, and tells the model what to do", () => {
    const ctx = createToolContext();
    const result = desk.handoff(ctx, billing, { note: "Verified: account 4471." });
    expect(result).toMatchObject({ handoff: true, from: "triage", to: "billing" });
    expect(result.note).toBe("Verified: account 4471.");
    expect(result.instruction).toContain("You are now billing");
    expect(desk.position(ctx)).toEqual({
      persona: billing,
      from: "triage",
      note: "Verified: account 4471.",
    });
  });

  it("accepts the target by name, and hands back to the entry persona", () => {
    const ctx = createToolContext();
    desk.handoff(ctx, "billing");
    expect(desk.handoff(ctx, "triage").from).toBe("billing");
    expect(desk.active(ctx)).toBe(triage);
  });

  it("is per SESSION: a second context still answers the entry persona", () => {
    const a = createToolContext();
    const b = createToolContext();
    desk.handoff(a, billing);
    expect(desk.active(b).name).toBe("triage");
  });

  it("refuses a target that is not on the roster", () => {
    const ctx = createToolContext();
    expect(() => desk.handoff(ctx, "shipping")).toThrow(/no persona called "shipping"/);
  });

  describe("refuses a roster that cannot route", () => {
    const valid: PersonaDef = { name: "a", description: "Does a.", systemPrompt: "Be a." };
    it("with nobody on it", () => {
      expect(() => personas([])).toThrow(/nobody on it/);
    });
    it("with two personas of one name", () => {
      expect(() => personas([valid, { ...valid, description: "Also a." }])).toThrow(
        /Two personas .* called "a"/,
      );
    });
    it("with a persona missing its description or its prompt", () => {
      expect(() => personas([{ ...valid, description: " " }])).toThrow(/no `description`/);
      expect(() => personas([{ ...valid, systemPrompt: "" }])).toThrow(/no `systemPrompt`/);
    });
    it("with a tool two personas both declare, or one named like the minted tool", () => {
      const b: PersonaDef = { ...valid, name: "b", tools: { lookup_invoice: lookupInvoice } };
      expect(() => personas([{ ...valid, tools: { lookup_invoice: lookupInvoice } }, b])).toThrow(
        /declared by two personas/,
      );
      expect(() => personas([{ ...valid, tools: { [HANDOFF_TOOL_NAME]: lookupInvoice } }])).toThrow(
        /name of the tool the roster mints/,
      );
    });
  });
});

describe("a dialog state may PIN a persona", () => {
  const script = dialog("script", {
    initial: "intake",
    states: {
      intake: { persona: "triage", on: { VERIFIED: "account" } },
      account: { persona: "billing", instruction: "Discuss the invoice.", on: { DONE: "closed" } },
      closed: { final: true },
    },
  });

  it("`agent()` refuses a pin naming a persona the roster does not carry", () => {
    const stray = dialog("stray", {
      initial: "a",
      states: { a: { persona: "shipping", on: { X: "b" } }, b: { final: true } },
    });
    expect(() => agent({ name: "x", personas: desk, dialogs: [stray] })).toThrow(
      /pins a persona called "shipping"/,
    );
  });

  it("`agent()` refuses a pin on an agent with no roster", () => {
    expect(() => agent({ name: "x", dialogs: [script] })).toThrow(/declares no `personas`/);
  });

  it("the pinned persona is the position while the dialog is in that state, and a handoff away is refused", () => {
    const bound = personas([triage, billing]);
    agent({ name: "Scripted", personas: bound, dialogs: [script] });
    const ctx = createToolContext();

    expect(bound.position(ctx)).toEqual({
      persona: triage,
      pinnedBy: { dialog: "script", state: "intake" },
    });
    expect(() => bound.handoff(ctx, billing)).toThrow(/pins "triage"/);

    script.send(ctx, { type: "VERIFIED" });
    expect(bound.active(ctx)).toBe(billing);
    expect(bound.position(ctx).pinnedBy).toEqual({ dialog: "script", state: "account" });

    // Handing off to the pinned persona is a no-op the tool may still make.
    expect(bound.handoff(ctx, billing).instruction).toContain("already billing");

    // Once the dialog leaves every pinning state, the slot decides again.
    script.send(ctx, { type: "DONE" });
    expect(bound.position(ctx)).toEqual({ persona: triage });
  });

  it("the pin is read through `DialogPosition.persona` too", () => {
    const ctx = createToolContext();
    expect(script.position(ctx).persona).toBe("triage");
  });
});
