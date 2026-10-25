// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate halves as `dialog.tool` runs them: `when` omitted, `reset`, the
 * two `sendFrom` forms that need no ordering, and the declaration refusals.
 *
 * Driven through `dialog.tool` rather than `compileDialogGate` directly: the
 * contract is what a declared tool does, and the compiled object is how the
 * two callers share it. The slot-side caller has its own suite
 * (`_slot-tools.test.ts`).
 */
import { describe, expect, test, vi } from "vitest";
import { runToolDef } from "./_test-utils.ts";
import { dialog } from "./dialog.ts";
import { createToolContext } from "./testing.ts";
import { instructionOf, withInstruction } from "./tool-instruction.ts";
import { isToolFailure, toolFailure } from "./utils.ts";

/** The reference flow, as a spec: two gated steps and an abandon arm. */
function claimFlow() {
  return dialog("claim", {
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
  });
}

describe("`when` omitted", () => {
  test("never refuses, in any state", async () => {
    const claim = claimFlow();
    const peek = claim.tool({ description: "Where are we", execute: () => ({ ok: true }) });
    const ctx = createToolContext();
    expect(await runToolDef(peek, ctx)).toMatchObject({ state: "verifying", result: { ok: true } });
    claim.send(ctx, { type: "VERIFIED" });
    expect(await runToolDef(peek, ctx)).toMatchObject({ state: "quoting", result: { ok: true } });
  });

  test("still honours `send`, and still answers the envelope", async () => {
    const claim = claimFlow();
    const abandon = claim.tool({
      description: "Give up",
      send: { type: "ABANDON" },
      execute: () => "gone",
    });
    const ctx = createToolContext();
    expect(await runToolDef(abandon, ctx)).toEqual({ state: "closed", done: true, result: "gone" });
  });

  test("a failure still sends nothing", async () => {
    const claim = claimFlow();
    const abandon = claim.tool({
      description: "Give up",
      send: { type: "ABANDON" },
      execute: () => toolFailure("not yet"),
    });
    const ctx = createToolContext();
    expect(isToolFailure(await runToolDef(abandon, ctx))).toBe(true);
    expect(claim.position(ctx).state).toBe("verifying");
  });
});

describe("one read per gated call", () => {
  test("a `when` over several states asks the handle's members nothing — one actor answers all of it", async () => {
    const claim = claimFlow();
    const tool = claim.tool({
      description: "Multi",
      when: ["verifying", "quoting", "settled"],
      send: { type: "VERIFIED" },
      execute: () => ({ ok: true }),
    });
    const matches = vi.spyOn(claim, "matches");
    const position = vi.spyOn(claim, "position");
    const ctx = createToolContext();
    expect(await runToolDef(tool, ctx)).toMatchObject({ state: "quoting", result: { ok: true } });
    expect(matches).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
  });
});

describe("a `withInstruction` result", () => {
  test("is lifted onto the envelope, where the runtime reads it, and stripped from `result`", async () => {
    const claim = claimFlow();
    const tool = claim.tool({
      description: "Verify",
      when: "verifying",
      send: { type: "VERIFIED" },
      execute: () => withInstruction({ policy: "P-1" }, "Read the policy number back."),
    });
    const ctx = createToolContext();
    const answered = await runToolDef(tool, ctx);
    expect(answered).toEqual({
      state: "quoting",
      done: false,
      instruction: "Read the excess disclosure, then quote.",
      result: { policy: "P-1" },
      $instruction: "Read the policy number back.",
    });
    expect(instructionOf(answered)).toBe("Read the policy number back.");
  });

  test("a failure carrying one is answered unchanged, and nothing is sent", async () => {
    const claim = claimFlow();
    const failed = withInstruction(toolFailure("No such policy."), "Ask for the number again.");
    const tool = claim.tool({
      description: "Verify",
      send: { type: "VERIFIED" },
      execute: () => failed,
    });
    const ctx = createToolContext();
    expect(await runToolDef(tool, ctx)).toBe(failed);
    expect(claim.position(ctx).state).toBe("verifying");
  });
});

describe("`reset: true`", () => {
  test("starts the dialog over before the body runs", async () => {
    const claim = claimFlow();
    const ctx = createToolContext();
    claim.send(ctx, { type: "VERIFIED" });
    const seen: string[] = [];
    const restart = claim.tool({
      description: "Start a new claim",
      reset: true,
      execute: (_args, c) => {
        seen.push(claim.position(c).state);
        return "fresh";
      },
    });
    expect(await runToolDef(restart, ctx)).toMatchObject({ state: "verifying", result: "fresh" });
    expect(seen).toEqual(["verifying"]);
  });

  test("a `when` is checked against the position BEFORE the reset", async () => {
    const claim = claimFlow();
    const ctx = createToolContext();
    const restart = claim.tool({
      description: "Start over, once quoting",
      when: "quoting",
      reset: true,
      execute: () => "fresh",
    });
    expect(isToolFailure(await runToolDef(restart, ctx))).toBe(true);
    claim.send(ctx, { type: "VERIFIED" });
    expect(await runToolDef(restart, ctx)).toMatchObject({ state: "verifying", result: "fresh" });
  });
});

describe("`sendFrom` as a field name", () => {
  test("sends the event the named field holds", async () => {
    const claim = claimFlow();
    const verify = claim.tool({
      description: "Verify",
      when: "verifying",
      sendFrom: "next",
      execute: (): { next?: "VERIFIED" | "ABANDON" } => ({ next: "VERIFIED" }),
    });
    const ctx = createToolContext();
    expect(await runToolDef(verify, ctx)).toMatchObject({ state: "quoting" });
  });

  test("stays put when the field is undefined", async () => {
    const claim = claimFlow();
    const verify = claim.tool({
      description: "Verify",
      when: "verifying",
      sendFrom: "next",
      execute: (): { next?: "VERIFIED"; reason: string } => ({ reason: "no match" }),
    });
    const ctx = createToolContext();
    expect(await runToolDef(verify, ctx)).toMatchObject({ state: "verifying" });
  });

  test("an UNTYPED caller whose field is not a name is refused, not silently ignored", async () => {
    const claim = claimFlow();
    // The erased shape a JS caller or a wrapper reaches the gate with.
    const verify = claim.tool({
      description: "Verify",
      sendFrom: "next",
      execute: (): { next?: "VERIFIED" } => JSON.parse('{"next":42}'),
    });
    const ctx = createToolContext();
    await expect(runToolDef(verify, ctx)).rejects.toThrow(/"next" field holds number/);
  });
});

describe("`sendFrom` as the second argument", () => {
  test("decides the transition from the settled result, written after the def", async () => {
    const claim = claimFlow();
    const verify = claim.tool(
      {
        description: "Verify",
        when: "verifying",
        execute: async () => ({ matched: true }),
      },
      { sendFrom: (result) => (result.matched ? { type: "VERIFIED" } : { type: "ABANDON" }) },
    );
    const ctx = createToolContext();
    expect(await runToolDef(verify, ctx)).toMatchObject({ state: "quoting" });
  });

  test("takes the field-name form too", async () => {
    const claim = claimFlow();
    const verify = claim.tool(
      {
        description: "Verify",
        execute: (): { next?: "ABANDON" } => ({ next: "ABANDON" }),
      },
      { sendFrom: "next" },
    );
    const ctx = createToolContext();
    expect(await runToolDef(verify, ctx)).toMatchObject({ state: "closed", done: true });
  });

  test("beside a `send` or `sendFrom` in the def it is refused at declaration", () => {
    const claim = claimFlow();
    expect(() =>
      claim.tool(
        { description: "Two", send: { type: "ABANDON" }, execute: () => "x" },
        { sendFrom: () => undefined },
      ),
    ).toThrow(/more than one of send, sendFrom/);
  });
});

describe("the sibling re-check", () => {
  test("a dialog moved during the body is not sent to, whichever form named the event", async () => {
    const claim = claimFlow();
    const ctx = createToolContext();
    const gate = Promise.withResolvers<void>();
    const quote = claim.tool({
      description: "Quote",
      when: "verifying",
      sendFrom: "next",
      execute: async (): Promise<{ next?: "VERIFIED" }> => {
        await gate.promise;
        return { next: "VERIFIED" };
      },
    });
    const call = runToolDef(quote, ctx);
    claim.send(ctx, { type: "ABANDON" });
    gate.resolve();
    expect(await call).toMatchObject({ state: "closed", result: { next: "VERIFIED" } });
  });
});

describe("`onEnter`", () => {
  /** A flow whose every state records its entry, nested included. */
  function hooked(log: string[]) {
    return dialog("hooked", {
      initial: "a",
      states: {
        a: { onEnter: () => log.push("a"), on: { GO: "b", STAY: "a", "@session.timedOut": "c" } },
        b: {
          onEnter: () => log.push("b"),
          initial: "x",
          states: {
            x: { onEnter: () => log.push("b.x"), on: { NEXT: "y" } },
            y: { onEnter: () => log.push("b.y"), on: { DONE: "#hooked.c" } },
          },
        },
        c: { onEnter: () => log.push("c"), final: true },
      },
    });
  }

  test("fires on `send`, parent before child, and not for the initial state", () => {
    const log: string[] = [];
    const flow = hooked(log);
    const ctx = createToolContext();
    expect(flow.position(ctx).state).toBe("a");
    expect(log).toEqual([]);
    flow.send(ctx, { type: "GO" });
    expect(log).toEqual(["b", "b.x"]);
    flow.send(ctx, { type: "NEXT" });
    expect(log).toEqual(["b", "b.x", "b.y"]);
  });

  test("fires on `receive`, and a self-transition does not re-enter", () => {
    const log: string[] = [];
    const flow = hooked(log);
    const ctx = createToolContext();
    flow.send(ctx, { type: "STAY" });
    expect(log).toEqual([]);
    flow.receive(ctx, { type: "session.timedOut", meta: { id: "evt_1", at: 0 } });
    expect(log).toEqual(["c"]);
  });

  test("a read of a stored position does not re-fire it, nor does `reset`", () => {
    const log: string[] = [];
    const flow = hooked(log);
    const ctx = createToolContext();
    flow.send(ctx, { type: "GO" });
    log.length = 0;
    expect(flow.position(ctx).state).toBe("b.x");
    expect(flow.matches(ctx, "b")).toBe(true);
    flow.projection((at) => at.state)(ctx.slots.read("hooked"));
    flow.reset(ctx);
    expect(log).toEqual([]);
  });

  test("is handed the holder the move came through, so it can write another slot", () => {
    const ctx = createToolContext();
    const holder = vi.fn();
    const flow = dialog("writer", {
      initial: "a",
      states: { a: { on: { GO: "b" } }, b: { onEnter: holder, final: true } },
    });
    flow.send(ctx, { type: "GO" });
    expect(holder).toHaveBeenCalledWith(ctx);
  });

  test("runs inside the window: a throw discards the move", () => {
    const ctx = createToolContext();
    const flow = dialog("throws", {
      initial: "a",
      states: {
        a: { on: { GO: "b" } },
        b: {
          onEnter: () => {
            throw new Error("not ready");
          },
          final: true,
        },
      },
    });
    expect(() => flow.send(ctx, { type: "GO" })).toThrow("not ready");
    expect(flow.position(ctx).state).toBe("a");
  });

  test("the snapshot stays plain JSON — the hook is not in it", () => {
    const log: string[] = [];
    const flow = hooked(log);
    const ctx = createToolContext();
    flow.send(ctx, { type: "GO" });
    const stored = ctx.slots.read("hooked");
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
  });
});
