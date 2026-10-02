// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `roster()` — its refusals, the handoff and what it returns,
 * and a dialog state's `persona` pin. The lowering into a toolset (the gate and
 * the minted `handoff`/`delegate` tools) is `roster-tools.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import { dialog } from "./dialog.ts";
import { DELEGATE_TOOL_NAME, HANDOFF_TOOL_NAME, type Roster, roster } from "./roster.ts";
import { type SpeakerDef, speaker } from "./speaker.ts";
import { createToolContext } from "./testing.ts";

const lookupInvoice = tool({
  description: "Look up an invoice",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, total: 42 }),
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
  toolChoice: "required",
  temperature: 0.2,
});

const researcher = speaker({
  name: "researcher",
  description: "Looks things up off the line",
  systemPrompt: "Research the task.",
});

const desk = roster([triage, billing, researcher]);

describe("roster()", () => {
  it("splits one list into who speaks and who is delegated to", () => {
    expect(desk.speaking).toEqual([triage, billing]);
    expect(desk.delegates).toEqual([researcher]);
  });

  it("answers as the first SPEAKING entry until a handoff", () => {
    const ctx = createToolContext();
    expect(desk.active(ctx).name).toBe("triage");
    expect(desk.position(ctx)).toEqual({ speaker: triage });
  });

  it("hands off, records who from and the note, and tells the model what to do", () => {
    const ctx = createToolContext();
    const result = desk.handoff(ctx, billing, { note: "Verified: account 4471." });
    expect(result).toMatchObject({ handoff: true, from: "triage", to: "billing" });
    expect(result.note).toBe("Verified: account 4471.");
    expect(result.instruction).toContain("You are now billing");
    expect(desk.position(ctx)).toEqual({
      speaker: billing,
      from: "triage",
      note: "Verified: account 4471.",
    });
  });

  it("accepts the target by name, and hands back to the entry speaker", () => {
    const ctx = createToolContext();
    desk.handoff(ctx, "billing");
    expect(desk.handoff(ctx, "triage").from).toBe("billing");
    expect(desk.active(ctx)).toBe(triage);
  });

  it("is per SESSION: a second context still answers the entry speaker", () => {
    const a = createToolContext();
    const b = createToolContext();
    desk.handoff(a, billing);
    expect(desk.active(b).name).toBe("triage");
  });

  it("refuses a target that is not on the roster, and one that does not speak", () => {
    const ctx = createToolContext();
    // Widened to the default `Roster`: the typed roster refuses the name at compile time.
    expect(() => (desk as Roster).handoff(ctx, "shipping")).toThrow(/no speaker called "shipping"/);
    expect(() => desk.handoff(ctx, researcher)).toThrow(/does not speak/);
  });

  it("has nobody on the line when no entry speaks", () => {
    const offLine = roster([researcher]);
    expect(offLine.speaking).toEqual([]);
    expect(() => offLine.position(createToolContext())).toThrow(/nobody is on the line/);
  });

  describe("refuses a roster that cannot route", () => {
    const valid: SpeakerDef = {
      name: "a",
      speaks: true,
      description: "Does a.",
      systemPrompt: "Be a.",
    };
    it("with nobody on it", () => {
      expect(() => roster([])).toThrow(/declares nobody/);
    });
    it("with two entries of one name", () => {
      expect(() => roster([valid, { ...valid, description: "Also a." }])).toThrow(
        /Two speakers .* called "a"/,
      );
    });
    it("with an entry missing its description or its prompt — speaking or not", () => {
      expect(() => roster([{ ...valid, description: " " }])).toThrow(/no `description`/);
      const { description: _description, ...nameless } = valid;
      expect(() => roster([{ ...nameless, speaks: false }])).toThrow(/no `description`/);
      expect(() => roster([{ ...valid, systemPrompt: "" }])).toThrow(/no `systemPrompt`/);
    });
    it("with a tool two speakers both declare, or one named like a minted tool", () => {
      const b: SpeakerDef = { ...valid, name: "b", tools: { lookup_invoice: lookupInvoice } };
      expect(() => roster([{ ...valid, tools: { lookup_invoice: lookupInvoice } }, b])).toThrow(
        /declared by two speakers/,
      );
      for (const minted of [HANDOFF_TOOL_NAME, DELEGATE_TOOL_NAME]) {
        expect(
          () => roster([{ ...valid, tools: { [minted]: lookupInvoice } }]),
          String(minted),
        ).toThrow(/name of a tool the roster mints/);
      }
    });
    it("but not a tool shared by entries that run OFF the line — each has its own loop", () => {
      const off: SpeakerDef = { ...valid, speaks: false, tools: { lookup_invoice: lookupInvoice } };
      expect(() => roster([off, { ...off, name: "b" }])).not.toThrow();
    });
  });
});

describe("a dialog state may PIN a speaking entry", () => {
  const script = dialog("script", {
    initial: "intake",
    states: {
      intake: { persona: "triage", on: { VERIFIED: "account" } },
      account: { persona: "billing", instruction: "Discuss the invoice.", on: { DONE: "closed" } },
      closed: { final: true },
    },
  });

  it("`agent()` refuses a pin naming an entry that is not a speaking one", () => {
    const stray = dialog("stray", {
      initial: "a",
      states: { a: { persona: "researcher", on: { X: "b" } }, b: { final: true } },
    });
    expect(() => agent({ name: "x", roster: desk, dialogs: [stray] })).toThrow(
      /pins a speaker called "researcher"/,
    );
  });

  it("`agent()` refuses a pin on an agent with no roster", () => {
    expect(() => agent({ name: "x", dialogs: [script] })).toThrow(/declares no `roster`/);
  });

  it("the pinned speaker is the position while the dialog is in that state, and a handoff away is refused", () => {
    const bound = roster([triage, billing]);
    agent({ name: "Scripted", roster: bound, dialogs: [script] });
    const ctx = createToolContext();

    expect(bound.position(ctx)).toEqual({
      speaker: triage,
      pinnedBy: { dialog: "script", state: "intake" },
    });
    expect(() => bound.handoff(ctx, billing)).toThrow(/pins "triage"/);

    script.send(ctx, { type: "VERIFIED" });
    expect(bound.active(ctx)).toBe(billing);
    expect(bound.position(ctx).pinnedBy).toEqual({ dialog: "script", state: "account" });

    // Handing off to the pinned speaker is a no-op the tool may still make.
    expect(bound.handoff(ctx, billing).instruction).toContain("already billing");

    // Once the dialog leaves every pinning state, the slot decides again.
    script.send(ctx, { type: "DONE" });
    expect(bound.position(ctx)).toEqual({ speaker: triage });
  });

  it("the pin is read through `DialogPosition.persona` too", () => {
    const ctx = createToolContext();
    expect(script.position(ctx).persona).toBe("triage");
  });
});
