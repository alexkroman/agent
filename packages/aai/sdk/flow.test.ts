// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { setup } from "xstate";
import { z } from "zod";
import { flow } from "./flow.ts";
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
          address: {},
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
    const claim = flow("claim", claimMachine());
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
    const at = flow("bare", machine).position(createToolContext());
    expect(at).not.toHaveProperty("instruction");
    expect(at.state).toBe("only");
  });

  test("reports a nested state as a dotted path", () => {
    const at = flow("intake", nestedMachine()).position(createToolContext());
    expect(at.state).toBe("collecting.name");
  });

  test("takes the instruction from the DEEPEST active state, not the parent", () => {
    const at = flow("intake", nestedMachine()).position(createToolContext());
    expect(at.instruction).toBe("Ask for their name.");
  });

  test("reports done once a final state is reached", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    expect(claim.position(ctx).done).toBe(false);
    claim.send(ctx, { type: "ABANDON" });
    expect(claim.position(ctx)).toMatchObject({ state: "closed", done: true });
  });
});

describe("send", () => {
  test("advances and persists, so a later read sees the new state", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    expect(claim.send(ctx, { type: "VERIFIED" }).state).toBe("quoting");
    // A separate read, through the slot store rather than the returned value.
    expect(claim.position(ctx).state).toBe("quoting");
  });

  test("an event the active state does not handle is ignored, not thrown", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    // `QUOTED` belongs to `quoting`; we are in `verifying`.
    expect(() => claim.send(ctx, { type: "QUOTED" })).not.toThrow();
    expect(claim.position(ctx).state).toBe("verifying");
  });

  test("two sessions do not share a position", () => {
    const claim = flow("claim", claimMachine());
    const alice = createToolContext();
    const bob = createToolContext();
    claim.send(alice, { type: "VERIFIED" });
    expect(claim.position(alice).state).toBe("quoting");
    expect(claim.position(bob).state).toBe("verifying");
  });

  test("carries the new state's instruction", () => {
    const claim = flow("claim", claimMachine());
    const moved = claim.send(createToolContext(), { type: "VERIFIED" });
    expect(moved.instruction).toBe("Read the excess disclosure, then quote.");
  });
});

describe("matches", () => {
  test("matches the active leaf and its parent", () => {
    const intake = flow("intake", nestedMachine());
    const ctx = createToolContext();
    expect(intake.matches(ctx, "collecting")).toBe(true);
    expect(intake.matches(ctx, "collecting.name")).toBe(true);
    expect(intake.matches(ctx, "collecting.address")).toBe(false);
  });
});

describe("reset", () => {
  test("returns the flow to its initial state", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    expect(claim.reset(ctx)).toMatchObject({ state: "verifying", done: false });
    expect(claim.position(ctx).state).toBe("verifying");
  });
});

describe("tool gating", () => {
  test("refuses out of state, and the refusal names where the conversation IS", async () => {
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
      states: { start: { on: { GO: "end" } }, end: {} },
    });
    const bare = flow("bare", machine);
    const gated = bare.tool({ description: "Only at the end", when: "end", execute: () => "ran" });
    const out = await run(gated, createToolContext());
    expect(out).toMatchObject({ error: expect.stringContaining("reach end first") });
  });

  test("the body does NOT run when the gate refuses", async () => {
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
  test("a ToolFailure from the body does NOT advance the flow", async () => {
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
    const verify = claim.tool({
      description: "Verify the policy",
      when: "verifying",
      execute: () => toolFailure("nope"),
    });
    expect(await run(verify, createToolContext())).toEqual({ error: "nope" });
  });

  test("sendFrom lets the result pick the transition", async () => {
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
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
    // A concurrent sibling moves the flow while this body is awaiting.
    advance = () => void claim.send(ctx, { type: "VERIFIED" });
    expect(await run(read, ctx)).toMatchObject({ state: "quoting", result: "read" });
  });

  test("preserves the tool's inputSchema", () => {
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
    const gated = claim.tool({ description: "d", when: "verifying", execute: () => "ok" });
    expect(gated).not.toHaveProperty("when");
    expect(gated).not.toHaveProperty("send");
  });
});

describe("declaration errors", () => {
  test("a `when` naming no state of the machine throws, listing the real ones", () => {
    const claim = flow("claim", claimMachine());
    expect(() => claim.tool({ description: "d", when: "quotting", execute: () => "ok" })).toThrow(
      /no state "quotting"/,
    );
  });

  test("that throw names the states that DO exist", () => {
    const claim = flow("claim", claimMachine());
    expect(() => claim.tool({ description: "d", when: "nope", execute: () => "ok" })).toThrow(
      /closed, quoting, settled, verifying/,
    );
  });

  test("a nested state is accepted at either depth", () => {
    const intake = flow("intake", nestedMachine());
    expect(() =>
      intake.tool({ description: "d", when: "collecting.address", execute: () => "ok" }),
    ).not.toThrow();
    expect(() =>
      intake.tool({ description: "d", when: "collecting", execute: () => "ok" }),
    ).not.toThrow();
  });

  test("declaring both send and sendFrom is refused", () => {
    const claim = flow("claim", claimMachine());
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
    const claim = flow("claim", claimMachine());
    const projection = claim.projection((at) => ({ step: at.state }));
    // Called with no value: what the runtime pushes before the first tool call.
    expect(projection(undefined)).toEqual({ step: "verifying" });
  });

  test("projects the stored position after a transition", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    const projection = claim.projection((at) => at);
    expect(projection(ctx.slots.read("claim"))).toMatchObject({ state: "quoting" });
  });

  test("carries the slot key, so `syncState` can address it", () => {
    const claim = flow("claim", claimMachine());
    expect(claim.projection((at) => at.state).key).toBe("claim");
  });
});

describe("identity", () => {
  test("exposes its key and its machine", () => {
    const machine = claimMachine();
    const claim = flow("claim", machine);
    expect(claim.key).toBe("claim");
    expect(claim.machine).toBe(machine);
  });

  test("a non-durable flow still tracks position within the session", () => {
    const claim = flow("claim", claimMachine(), { durable: false });
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    expect(claim.position(ctx).state).toBe("quoting");
  });
});

describe("stored shape", () => {
  test("stores a plain JSON snapshot, so a durable slot can hold it", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    const stored = ctx.slots.read("claim");
    // Round-tripping through JSON is what a durable slot does to it; the flow
    // has to come back in the same place.
    expect(JSON.parse(JSON.stringify(stored))).toMatchObject({ snapshot: { value: "quoting" } });
  });

  test("a slot holding something else starts the machine over rather than throwing", () => {
    const claim = flow("claim", claimMachine());
    const ctx = createToolContext();
    ctx.slots.write("claim", { snapshot: "not a snapshot" }, true);
    expect(claim.position(ctx).state).toBe("verifying");
  });
});

describe("the invariant", () => {
  /**
   * A flow beside the slot it is ABOUT, wired the way a template wires one: the
   * position says a quote is in progress, and `quoted` is the data that has to
   * agree with it.
   */
  function quoteFlow(store: { quoted: boolean }) {
    return flow("claim", claimMachine(), {
      invariant: (at) =>
        at.state === "quoting" && !store.quoted
          ? "the position says quoting but no quote was recorded."
          : undefined,
    });
  }

  test("agreeing position and data let a gated tool through", async () => {
    const store = { quoted: true };
    const claim = quoteFlow(store);
    const tool = claim.tool({ description: "d", when: "quoting", execute: () => ({ ok: true }) });
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });

    expect(claim.check(ctx)).toBeUndefined();
    expect(await run(tool, ctx)).toMatchObject({ state: "quoting", result: { ok: true } });
  });

  test("a disagreement refuses the call and NAMES it, rather than gating on it", async () => {
    // The failure this exists to prevent: without the invariant the position is
    // `quoting`, the gate passes, and the body runs against data that never had
    // a quote in it. With it, the refusal says which two things disagree.
    const store = { quoted: false };
    const claim = quoteFlow(store);
    const ran = { body: false };
    const tool = claim.tool({
      description: "d",
      when: "quoting",
      execute: () => {
        ran.body = true;
        return { ok: true };
      },
    });
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });

    const answered = await run(tool, ctx);
    expect(isToolFailure(answered)).toBe(true);
    expect(isToolFailure(answered) && answered.error).toContain("no quote was recorded");
    expect(isToolFailure(answered) && answered.error).toContain("bug in the agent");
    // The body did not run, and the refusal is NOT the ordinary out-of-state one.
    expect(ran.body).toBe(false);
    expect(isToolFailure(answered) && answered.error).not.toContain("Not available yet");
  });

  test("check() answers at the seam that breaks it, before any tool is called", () => {
    const store = { quoted: false };
    const claim = quoteFlow(store);
    const ctx = createToolContext();
    expect(claim.check(ctx)).toBeUndefined(); // `verifying` — nothing claimed yet
    claim.send(ctx, { type: "VERIFIED" });
    expect(claim.check(ctx)).toContain("no quote was recorded");
  });

  test("a flow that declares no invariant always agrees", async () => {
    const claim = flow("claim", claimMachine());
    const tool = claim.tool({ description: "d", when: "verifying", execute: () => 1 });
    const ctx = createToolContext();
    expect(claim.check(ctx)).toBeUndefined();
    expect(await run(tool, ctx)).toMatchObject({ result: 1 });
  });

  test("the invariant is read BEFORE the gate, so a stale position cannot mask it", async () => {
    // Out of state AND disagreeing: the disagreement is the more useful fact,
    // because the out-of-state refusal would send the model to fix the wrong
    // thing — it names a position that is itself untrustworthy.
    const store = { quoted: false };
    const claim = quoteFlow(store);
    const tool = claim.tool({ description: "d", when: "verifying", execute: () => 1 });
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" }); // now in `quoting`, which disagrees

    const answered = await run(tool, ctx);
    expect(isToolFailure(answered) && answered.error).toContain("disagree");
  });

  test("a ToolFailure body still blocks the transition with an invariant declared", async () => {
    const store = { quoted: true };
    const claim = quoteFlow(store);
    const tool = claim.tool({
      description: "d",
      when: "verifying",
      send: { type: "VERIFIED" },
      execute: () => toolFailure("nope"),
    });
    const ctx = createToolContext();
    expect(await run(tool, ctx)).toEqual({ error: "nope" });
    expect(claim.position(ctx).state).toBe("verifying");
  });
});
