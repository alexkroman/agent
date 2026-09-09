// Copyright 2026 the AAI authors. MIT license.
/**
 * The PLAIN-SPEC declaration form — `dialog(key, { states })` rather than
 * `dialog(key, machine)`.
 *
 * Split out of `dialog.test.ts` when that file crossed the 700-line cap for
 * test files. The seam is the one the suite already had: every other block
 * there drives the machine form, and this one is the only block that declares
 * its own states. `claimMachine` is duplicated below rather than shared,
 * because the point of the last test is that the TWO forms agree — a fixture
 * imported from the other file would make that a tautology about one object.
 */
import { describe, expect, test } from "vitest";
import { setup } from "xstate";
import { z } from "zod";
import { dialog } from "./dialog.ts";
import { createToolContext } from "./testing.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure } from "./utils.ts";

/** Run a tool the way the runtime does, and hand back whatever it answered. */
async function run(tool: ToolDef, ctx: ToolContext): Promise<unknown> {
  return await tool.execute({}, ctx);
}

/** The machine form of `claimSpec`, for the equivalence test at the end. */
function claimMachine() {
  return setup({
    types: {} as { events: { type: "VERIFIED" } | { type: "QUOTED" } | { type: "ABANDON" } },
  }).createMachine({
    id: "claim",
    initial: "verifying",
    states: {
      verifying: {
        meta: { instruction: "Get the caller's policy number and verify it." },
        on: { VERIFIED: "quoting", ABANDON: "closed" },
      },
      quoting: {
        meta: { instruction: "Read the excess disclosure, then quote." },
        on: { QUOTED: "settled" },
      },
      settled: { type: "final" },
      closed: { type: "final" },
    },
  });
}

describe("the plain-spec form", () => {
  /** The same two-step call as `claimMachine`, written as a state map. */
  const claimSpec = {
    initial: "verifying",
    states: {
      verifying: {
        instruction: "Get the caller's policy number and verify it.",
        on: { VERIFIED: "quoting", ABANDON: "closed" },
      },
      quoting: {
        instruction: "Read the excess disclosure, then quote.",
        on: { QUOTED: "settled" },
      },
      settled: { final: true },
      closed: { final: true },
    },
  } as const;

  test("starts where the spec says, carrying that state's instruction", () => {
    const at = dialog("claim", claimSpec).position(createToolContext());
    expect(at).toEqual({
      state: "verifying",
      done: false,
      instruction: "Get the caller's policy number and verify it.",
    });
  });

  test("a state with no instruction omits the field, as the machine form does", () => {
    const at = dialog("bare", { initial: "only", states: { only: {} } }).position(
      createToolContext(),
    );
    expect(at).not.toHaveProperty("instruction");
    expect(at.state).toBe("only");
  });

  test("`on` transitions move it, and `final: true` ends it", () => {
    const claim = dialog("claim", claimSpec);
    const ctx = createToolContext();
    expect(claim.send(ctx, { type: "VERIFIED" })).toMatchObject({
      state: "quoting",
      done: false,
      instruction: "Read the excess disclosure, then quote.",
    });
    expect(claim.send(ctx, { type: "QUOTED" })).toMatchObject({ state: "settled", done: true });
  });

  test("nested states get the same dotted path and deepest-instruction rule", () => {
    const intake = dialog("intake", {
      initial: "collecting",
      states: {
        collecting: {
          instruction: "Parent guidance.",
          initial: "name",
          states: {
            name: { instruction: "Ask for their name.", on: { SUBMIT: "address" } },
            address: { final: true },
          },
        },
      },
    });
    const ctx = createToolContext();
    expect(intake.position(ctx)).toMatchObject({
      state: "collecting.name",
      instruction: "Ask for their name.",
    });
    expect(intake.send(ctx, { type: "SUBMIT" }).state).toBe("collecting.address");
  });

  test("a nested state can target the root by id, because the machine id IS the key", () => {
    // `machineFromSpec` names the machine after the dialog's key, which is the
    // only name a dialog already has — so `#<key>.<state>` is the escape upward
    // out of a nested region, exactly as it is in a hand-written machine.
    const quote = dialog("quote", {
      initial: "collecting",
      states: {
        collecting: {
          initial: "pending",
          states: {
            pending: { on: { PRICED: "ready" } },
            ready: { on: { QUOTED: "#quote.done" } },
          },
        },
        done: { final: true },
      },
    });
    const ctx = createToolContext();
    expect(quote.send(ctx, { type: "PRICED" }).state).toBe("collecting.ready");
    expect(quote.send(ctx, { type: "QUOTED" })).toMatchObject({ state: "done", done: true });
  });

  test("a `when` naming a state the spec does not declare still throws at declaration", () => {
    const claim = dialog("claim", claimSpec);
    expect(() =>
      claim.tool({
        description: "Quote the claim",
        when: "quotting",
        execute: () => ({ premium: 1 }),
      }),
    ).toThrow(/no state "quotting"/);
  });

  test("a gated tool refuses out of state and advances in it", async () => {
    const claim = dialog("claim", claimSpec);
    const quote = claim.tool({
      description: "Quote the claim",
      inputSchema: z.object({}),
      when: "quoting",
      send: { type: "QUOTED" },
      execute: () => ({ premium: 500 }),
    });
    const ctx = createToolContext();
    const refused = await run(quote, ctx);
    expect(isToolFailure(refused)).toBe(true);
    claim.send(ctx, { type: "VERIFIED" });
    expect(await run(quote, ctx)).toEqual({
      state: "settled",
      done: true,
      result: { premium: 500 },
    });
  });

  test("the stored snapshot is the machine form's, so a durable dialog resumes across the switch", () => {
    // The property the spec form exists ON TOP of rather than beside: it
    // compiles to an ordinary machine, so a session persisted by an agent
    // written one way is readable by the same dialog written the other. Both
    // occupy the key "claim", so both read the same slot in this one context.
    const ctx = createToolContext();
    const asMachine = dialog("claim", claimMachine());
    expect(asMachine.send(ctx, { type: "VERIFIED" }).state).toBe("quoting");

    const asSpec = dialog("claim", claimSpec);
    expect(asSpec.position(ctx)).toMatchObject({
      state: "quoting",
      instruction: "Read the excess disclosure, then quote.",
    });
    expect(asSpec.send(ctx, { type: "QUOTED" })).toMatchObject({ state: "settled", done: true });
  });
});
