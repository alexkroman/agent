// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { setup } from "xstate";
import { z } from "zod";
import { dialog } from "./dialog.ts";
import { createToolContext } from "./testing.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure, toolFailure } from "./utils.ts";

/**
 * The reference shape: a two-step gated call, each state carrying the
 * instruction the agent is supposed to be following while it is there.
 */
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

/** A nested machine, for the dotted path and the deepest-instruction rule. */
function nestedMachine() {
  return setup({ types: {} as { events: { type: "SUBMIT" } } }).createMachine({
    id: "intake",
    initial: "collecting",
    states: {
      collecting: {
        meta: { instruction: "Parent guidance." },
        initial: "name",
        states: {
          name: { meta: { instruction: "Ask for their name." }, on: { SUBMIT: "address" } },
          // `final` because the graph guard refuses a leaf with no way out, and
          // an intake that has both names really is finished — this fixture is
          // about nesting, not about being stuck in it.
          address: { type: "final" },
        },
      },
    },
  });
}

/** Run a tool the way the runtime does, and hand back whatever it answered. */
async function run(tool: ToolDef, ctx: ToolContext): Promise<unknown> {
  return await tool.execute({}, ctx);
}

describe("position", () => {
  test("starts at the machine's initial state, with that state's instruction", () => {
    const claim = dialog("claim", claimMachine());
    const at = claim.position(createToolContext());
    expect(at).toEqual({
      state: "verifying",
      done: false,
      instruction: "Get the caller's policy number and verify it.",
    });
  });

  test("a state with no meta.instruction omits the field entirely", () => {
    const machine = setup({ types: {} as { events: { type: "GO" } } }).createMachine({
      id: "bare",
      initial: "only",
      states: { only: {} },
    });
    const at = dialog("bare", machine).position(createToolContext());
    expect(at).not.toHaveProperty("instruction");
    expect(at.state).toBe("only");
  });

  test("reports a nested state as a dotted path", () => {
    const at = dialog("intake", nestedMachine()).position(createToolContext());
    expect(at.state).toBe("collecting.name");
  });

  test("takes the instruction from the DEEPEST active state, not the parent", () => {
    const at = dialog("intake", nestedMachine()).position(createToolContext());
    expect(at.instruction).toBe("Ask for their name.");
  });

  test("reports done once a final state is reached", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    expect(claim.position(ctx).done).toBe(false);
    claim.send(ctx, { type: "ABANDON" });
    expect(claim.position(ctx)).toMatchObject({ state: "closed", done: true });
  });
});

describe("send", () => {
  test("advances and persists, so a later read sees the new state", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    expect(claim.send(ctx, { type: "VERIFIED" }).state).toBe("quoting");
    // A separate read, through the slot store rather than the returned value.
    expect(claim.position(ctx).state).toBe("quoting");
  });

  test("an event the active state does not handle is ignored, not thrown", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    // `QUOTED` belongs to `quoting`; we are in `verifying`.
    expect(() => claim.send(ctx, { type: "QUOTED" })).not.toThrow();
    expect(claim.position(ctx).state).toBe("verifying");
  });

  test("two sessions do not share a position", () => {
    const claim = dialog("claim", claimMachine());
    const alice = createToolContext();
    const bob = createToolContext();
    claim.send(alice, { type: "VERIFIED" });
    expect(claim.position(alice).state).toBe("quoting");
    expect(claim.position(bob).state).toBe("verifying");
  });

  test("carries the new state's instruction", () => {
    const claim = dialog("claim", claimMachine());
    const moved = claim.send(createToolContext(), { type: "VERIFIED" });
    expect(moved.instruction).toBe("Read the excess disclosure, then quote.");
  });
});

describe("matches", () => {
  test("matches the active leaf and its parent", () => {
    const intake = dialog("intake", nestedMachine());
    const ctx = createToolContext();
    expect(intake.matches(ctx, "collecting")).toBe(true);
    expect(intake.matches(ctx, "collecting.name")).toBe(true);
    expect(intake.matches(ctx, "collecting.address")).toBe(false);
  });
});

describe("reset", () => {
  test("returns the dialog to its initial state", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    expect(claim.reset(ctx)).toMatchObject({ state: "verifying", done: false });
    expect(claim.position(ctx).state).toBe("verifying");
  });
});

describe("tool gating", () => {
  test("refuses out of state, and the refusal names where the conversation IS", async () => {
    const claim = dialog("claim", claimMachine());
    const quote = claim.tool({
      description: "Quote the claim",
      when: "quoting",
      send: { type: "QUOTED" },
      execute: () => ({ premium: 42 }),
    });
    const out = await run(quote, createToolContext());
    expect(isToolFailure(out)).toBe(true);
    expect(out).toMatchObject({ error: expect.stringContaining('"verifying"') });
  });

  test("the refusal quotes the current state's instruction, so the model can recover", async () => {
    const claim = dialog("claim", claimMachine());
    const quote = claim.tool({
      description: "Quote the claim",
      when: "quoting",
      execute: () => ({ premium: 42 }),
    });
    const out = await run(quote, createToolContext());
    expect(out).toMatchObject({
      error: expect.stringContaining("Get the caller's policy number and verify it."),
    });
  });

  test("falls back to naming the required states when the state declares no instruction", async () => {
    const machine = setup({ types: {} as { events: { type: "GO" } } }).createMachine({
      id: "bare",
      initial: "start",
      // `final` because the graph guard refuses a leaf with no way out, and
      // `end` is where this dialog ends.
      states: { start: { on: { GO: "end" } }, end: { type: "final" } },
    });
    const bare = dialog("bare", machine);
    const gated = bare.tool({ description: "Only at the end", when: "end", execute: () => "ran" });
    const out = await run(gated, createToolContext());
    expect(out).toMatchObject({ error: expect.stringContaining("reach end first") });
  });

  test("the body does NOT run when the gate refuses", async () => {
    const claim = dialog("claim", claimMachine());
    let ran = false;
    const quote = claim.tool({
      description: "Quote the claim",
      when: "quoting",
      execute: () => {
        ran = true;
        return {};
      },
    });
    await run(quote, createToolContext());
    expect(ran).toBe(false);
  });

  test("runs in state, and wraps the author's result in the position", async () => {
    const claim = dialog("claim", claimMachine());
    const quote = claim.tool({
      description: "Quote the claim",
      when: "quoting",
      send: { type: "QUOTED" },
      execute: () => ({ premium: 42 }),
    });
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    const out = await run(quote, ctx);
    expect(out).toMatchObject({ state: "settled", done: true, result: { premium: 42 } });
  });

  test("accepts a list of states", async () => {
    const claim = dialog("claim", claimMachine());
    const note = claim.tool({
      description: "Leave a note",
      when: ["verifying", "quoting"],
      execute: () => "noted",
    });
    const ctx = createToolContext();
    expect(await run(note, ctx)).toMatchObject({ state: "verifying", result: "noted" });
    claim.send(ctx, { type: "VERIFIED" });
    expect(await run(note, ctx)).toMatchObject({ state: "quoting", result: "noted" });
  });

  test("a tool declaring neither send nor sendFrom leaves the position alone", async () => {
    const claim = dialog("claim", claimMachine());
    const read = claim.tool({
      description: "Read the file",
      when: "verifying",
      execute: () => "read",
    });
    const ctx = createToolContext();
    expect(await run(read, ctx)).toMatchObject({ state: "verifying", result: "read" });
    expect(claim.position(ctx).state).toBe("verifying");
  });

  test("the result carries the instruction of the state it landed in", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      send: { type: "VERIFIED" },
      execute: () => "ok",
    });
    const out = await run(verify, createToolContext());
    expect(out).toMatchObject({ instruction: "Read the excess disclosure, then quote." });
  });
});

describe("tool transitions", () => {
  test("a ToolFailure from the body does NOT advance the dialog", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      send: { type: "VERIFIED" },
      execute: () => toolFailure("That policy number is not on file."),
    });
    const ctx = createToolContext();
    const out = await run(verify, ctx);
    expect(isToolFailure(out)).toBe(true);
    // The whole point: a tool that failed did not do the thing, so every later
    // gate would be wrong if the conversation had moved on.
    expect(claim.position(ctx).state).toBe("verifying");
  });

  test("a ToolFailure is returned unwrapped, not nested under `result`", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      execute: () => toolFailure("nope"),
    });
    expect(await run(verify, createToolContext())).toEqual({ error: "nope" });
  });

  test("sendFrom lets the result pick the transition", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      sendFrom: (result: { ok: boolean }) =>
        result.ok ? ({ type: "VERIFIED" } as const) : ({ type: "ABANDON" } as const),
      execute: () => ({ ok: false }),
    });
    const ctx = createToolContext();
    expect(await run(verify, ctx)).toMatchObject({ state: "closed", done: true });
  });

  test("sendFrom returning undefined stays put", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      sendFrom: () => undefined,
      execute: () => "ok",
    });
    const ctx = createToolContext();
    expect(await run(verify, ctx)).toMatchObject({ state: "verifying" });
    expect(claim.position(ctx).state).toBe("verifying");
  });

  test("awaits an async body before deciding the transition", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      send: { type: "VERIFIED" },
      execute: async () => {
        await Promise.resolve();
        return { checked: true };
      },
    });
    const ctx = createToolContext();
    expect(await run(verify, ctx)).toMatchObject({
      state: "quoting",
      result: { checked: true },
    });
  });

  test("an ASYNC body returning a ToolFailure does not advance either", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      send: { type: "VERIFIED" },
      execute: async () => {
        await Promise.resolve();
        return toolFailure("not on file");
      },
    });
    const ctx = createToolContext();
    const out = await run(verify, ctx);
    expect(isToolFailure(out)).toBe(true);
    expect(claim.position(ctx).state).toBe("verifying");
  });

  test("sendFrom sees the SETTLED value of an async body", async () => {
    const claim = dialog("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      sendFrom: (result: { ok: boolean }) =>
        result.ok ? ({ type: "VERIFIED" } as const) : ({ type: "ABANDON" } as const),
      execute: async () => {
        await Promise.resolve();
        return { ok: true };
      },
    });
    expect(await run(verify, createToolContext())).toMatchObject({ state: "quoting" });
  });

  test("a non-advancing tool reports the position as of when it SETTLED", async () => {
    const claim = dialog("claim", claimMachine());
    let advance: (() => void) | undefined;
    const read = claim.tool({
      description: "Read the file",
      when: "verifying",
      execute: async () => {
        advance?.();
        await Promise.resolve();
        return "read";
      },
    });
    const ctx = createToolContext();
    // A concurrent sibling moves the dialog while this body is awaiting.
    advance = () => void claim.send(ctx, { type: "VERIFIED" });
    expect(await run(read, ctx)).toMatchObject({ state: "quoting", result: "read" });
  });

  test("preserves the tool's inputSchema", () => {
    const claim = dialog("claim", claimMachine());
    const schema = z.object({ note: z.string() });
    const gated = claim.tool({
      description: "Takes input",
      inputSchema: schema,
      when: "verifying",
      execute: () => "ok",
    });
    expect(gated.inputSchema).toBe(schema);
    expect(gated.description).toBe("Takes input");
  });

  test("does not leak `when` onto the ToolDef the runtime sees", () => {
    const claim = dialog("claim", claimMachine());
    const gated = claim.tool({ description: "d", when: "verifying", execute: () => "ok" });
    expect(gated).not.toHaveProperty("when");
    expect(gated).not.toHaveProperty("send");
  });
});

describe("declaration errors", () => {
  test("a `when` naming no state of the machine throws, listing the real ones", () => {
    const claim = dialog("claim", claimMachine());
    expect(() => claim.tool({ description: "d", when: "quotting", execute: () => "ok" })).toThrow(
      /no state "quotting"/,
    );
  });

  test("that throw names the states that DO exist", () => {
    const claim = dialog("claim", claimMachine());
    expect(() => claim.tool({ description: "d", when: "nope", execute: () => "ok" })).toThrow(
      /closed, quoting, settled, verifying/,
    );
  });

  test("a nested state is accepted at either depth", () => {
    const intake = dialog("intake", nestedMachine());
    expect(() =>
      intake.tool({ description: "d", when: "collecting.address", execute: () => "ok" }),
    ).not.toThrow();
    expect(() =>
      intake.tool({ description: "d", when: "collecting", execute: () => "ok" }),
    ).not.toThrow();
  });

  test("declaring both send and sendFrom is refused", () => {
    const claim = dialog("claim", claimMachine());
    expect(() =>
      claim.tool({
        description: "d",
        when: "verifying",
        send: { type: "VERIFIED" },
        sendFrom: () => ({ type: "ABANDON" }) as const,
        execute: () => "ok",
      }),
    ).toThrow(/both send and sendFrom/);
  });
});

describe("projection", () => {
  test("projects the position for a session that has run no tool yet", () => {
    const claim = dialog("claim", claimMachine());
    const projection = claim.projection((at) => ({ step: at.state }));
    // Called with no value: what the runtime pushes before the first tool call.
    expect(projection(undefined)).toEqual({ step: "verifying" });
  });

  test("projects the stored position after a transition", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    const projection = claim.projection((at) => at);
    expect(projection(ctx.slots.read("claim"))).toMatchObject({ state: "quoting" });
  });

  test("carries the slot key, so `syncState` can address it", () => {
    const claim = dialog("claim", claimMachine());
    expect(claim.projection((at) => at.state).key).toBe("claim");
  });
});

describe("identity", () => {
  test("exposes its key and its machine", () => {
    const machine = claimMachine();
    const claim = dialog("claim", machine);
    expect(claim.key).toBe("claim");
    expect(claim.machine).toBe(machine);
  });

  test("a non-durable dialog still tracks position within the session", () => {
    const claim = dialog("claim", claimMachine(), { durable: false });
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    expect(claim.position(ctx).state).toBe("quoting");
  });
});

describe("stored shape", () => {
  test("stores a plain JSON snapshot, so a durable slot can hold it", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    const stored = ctx.slots.read("claim");
    // Round-tripping through JSON is what a durable slot does to it; the dialog
    // has to come back in the same place.
    expect(JSON.parse(JSON.stringify(stored))).toMatchObject({ snapshot: { value: "quoting" } });
  });

  test("a slot holding something else starts the machine over rather than throwing", () => {
    const claim = dialog("claim", claimMachine());
    const ctx = createToolContext();
    ctx.slots.write("claim", { snapshot: "not a snapshot" }, true);
    expect(claim.position(ctx).state).toBe("verifying");
  });
});

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

describe("dialog declaration guards", () => {
  test("names the signature when the key is left off", () => {
    // Every other authoring function here takes one object — `agent({…})`,
    // `tool({…})`, `workflow({…})` — so `dialog({…})` is the natural slip, and
    // it used to die on `Cannot use 'in' operator to search for 'transition' in
    // undefined` from a stack naming neither the function nor the key.
    // `Reflect.apply` rather than a cast: the caller this guards is one the
    // compiler never saw, and a cast here would spend a counted escape hatch to
    // say so.
    expect(() => Reflect.apply(dialog, undefined, [{ initial: "a", states: { a: {} } }])).toThrow(
      /dialog\(key, spec\) takes the KEY first/,
    );
  });

  test("refuses an initial state the spec does not declare", () => {
    // XState resolves it to a state that does not exist: every `position()`
    // reads as that name and no event transitions, so the dialog is stuck
    // before the first turn with nothing saying why.
    expect(() => dialog("stuck", { initial: "greet", states: { hello: {} } })).toThrow(
      /starts in "greet", which is not one of its states \(hello\)/,
    );
  });

  test("a declared initial state is fine", () => {
    expect(dialog("fine", { initial: "hello", states: { hello: {} } }).key).toBe("fine");
  });
});
