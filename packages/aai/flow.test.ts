import { describe, expect, it } from "vitest";
import type { FlowState } from "./flow.ts";
import { defineFlow } from "./flow.ts";
import type { HookContext } from "./types.ts";

function makeCtx(flowState: FlowState): HookContext<FlowState & Record<string, unknown>> {
  // Minimal context matching HookContext shape for testing
  return {
    state: { ...flowState },
    env: {},
    kv: {} as HookContext["kv"],
    vector: {} as HookContext["vector"],
    fetch: globalThis.fetch,
    sessionId: "test-session",
  };
}

const bookingFlow = defineFlow({
  initial: "greeting",
  steps: {
    greeting: {
      instructions: "Greet the user.",
      activeTools: ["lookup"],
      on: { SERVICE_SELECTED: "collect" },
    },
    collect: {
      instructions: "Collect info.",
      activeTools: ["save_info", "check_avail"],
      on: { INFO_COMPLETE: "confirm" },
    },
    confirm: {
      instructions: "Confirm booking.",
      activeTools: ["book"],
      on: { CONFIRMED: "done", RESTART: "greeting" },
    },
    done: {
      instructions: "Thank the user.",
      terminal: true,
    },
  },
});

describe("defineFlow", () => {
  it("returns initial state with the initial step", () => {
    const state = bookingFlow.initialState();
    expect(state).toEqual({ __flow: "greeting" });
  });

  it("rejects unknown initial step", () => {
    expect(() =>
      defineFlow({
        initial: "nonexistent" as "a",
        steps: { a: {} },
      }),
    ).toThrow('Initial step "nonexistent" is not defined');
  });

  it("rejects transitions to unknown steps", () => {
    expect(() =>
      defineFlow({
        initial: "a",
        steps: {
          a: { on: { GO: "nowhere" } },
        },
      }),
    ).toThrow('targeting unknown step "nowhere"');
  });
});

describe("transition", () => {
  it("advances to the target step", () => {
    const ctx = makeCtx(bookingFlow.initialState());
    expect(bookingFlow.currentStep(ctx)).toBe("greeting");

    bookingFlow.transition(ctx, "SERVICE_SELECTED");
    expect(bookingFlow.currentStep(ctx)).toBe("collect");
  });

  it("supports multi-hop transitions", () => {
    const ctx = makeCtx(bookingFlow.initialState());
    bookingFlow.transition(ctx, "SERVICE_SELECTED");
    bookingFlow.transition(ctx, "INFO_COMPLETE");
    bookingFlow.transition(ctx, "CONFIRMED");
    expect(bookingFlow.currentStep(ctx)).toBe("done");
  });

  it("supports transitions back to earlier steps", () => {
    const ctx = makeCtx(bookingFlow.initialState());
    bookingFlow.transition(ctx, "SERVICE_SELECTED");
    bookingFlow.transition(ctx, "INFO_COMPLETE");
    bookingFlow.transition(ctx, "RESTART");
    expect(bookingFlow.currentStep(ctx)).toBe("greeting");
  });

  it("throws on unknown event", () => {
    const ctx = makeCtx(bookingFlow.initialState());
    expect(() => bookingFlow.transition(ctx, "BOGUS")).toThrow(
      'No transition "BOGUS" from step "greeting"',
    );
  });

  it("throws when transitioning from terminal step", () => {
    const ctx = makeCtx({ __flow: "done" });
    expect(() => bookingFlow.transition(ctx, "RESTART")).toThrow(
      'Cannot transition from terminal step "done"',
    );
  });

  it("throws on unknown current step", () => {
    const ctx = makeCtx({ __flow: "ghost" });
    expect(() => bookingFlow.transition(ctx, "GO")).toThrow('Unknown flow step: "ghost"');
  });

  it("lists available events in error message", () => {
    const ctx = makeCtx({ __flow: "confirm" });
    expect(() => bookingFlow.transition(ctx, "NOPE")).toThrow(
      "Available events: CONFIRMED, RESTART",
    );
  });
});

describe("middleware", () => {
  const mw = bookingFlow.middleware();

  describe("beforeInput", () => {
    it("prepends step instructions to user text", () => {
      const ctx = makeCtx({ __flow: "greeting" });
      const result = mw.beforeInput?.("hello", ctx);
      expect(result).toBe("[Dialog step: greeting]\n[Step instructions: Greet the user.]\n\nhello");
    });

    it("passes through text when step has no instructions", () => {
      const flow = defineFlow({
        initial: "bare",
        steps: { bare: {} },
      });
      const ctx = makeCtx(flow.initialState());
      const mwBare = flow.middleware();
      expect(mwBare.beforeInput?.("hi", ctx)).toBe("hi");
    });
  });

  describe("beforeToolCall", () => {
    it("allows tools listed in activeTools", () => {
      const ctx = makeCtx({ __flow: "greeting" });
      const result = mw.beforeToolCall?.("lookup", {}, ctx);
      expect(result).toBeUndefined();
    });

    it("blocks tools not in activeTools", () => {
      const ctx = makeCtx({ __flow: "greeting" });
      const result = mw.beforeToolCall?.("save_info", {}, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining(
          'Tool "save_info" is not available in dialog step "greeting"',
        ),
      });
    });

    it("allows any tool when step has no activeTools", () => {
      const flow = defineFlow({
        initial: "open",
        steps: { open: {} },
      });
      const ctx = makeCtx(flow.initialState());
      const mwOpen = flow.middleware();
      expect(mwOpen.beforeToolCall?.("anything", {}, ctx)).toBeUndefined();
    });

    it("gates tools based on current step after transition", () => {
      const ctx = makeCtx(bookingFlow.initialState());

      // In greeting step, save_info is blocked
      expect(mw.beforeToolCall?.("save_info", {}, ctx)).toEqual(
        expect.objectContaining({ block: true }),
      );

      // Transition to collect step
      bookingFlow.transition(ctx, "SERVICE_SELECTED");

      // Now save_info is allowed
      expect(mw.beforeToolCall?.("save_info", {}, ctx)).toBeUndefined();

      // But lookup is blocked
      expect(mw.beforeToolCall?.("lookup", {}, ctx)).toEqual(
        expect.objectContaining({ block: true }),
      );
    });
  });

  it("has name 'flow'", () => {
    expect(mw.name).toBe("flow");
  });
});

describe("currentStep", () => {
  it("returns the current step name", () => {
    const ctx = makeCtx(bookingFlow.initialState());
    expect(bookingFlow.currentStep(ctx)).toBe("greeting");
  });
});
