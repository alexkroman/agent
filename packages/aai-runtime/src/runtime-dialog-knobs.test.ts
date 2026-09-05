// Copyright 2026 the AAI authors. MIT license.

import { type AnyDialog, dialog, type SlotHolder } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { mergeTurnKnobs, reportDialogKnobs } from "./runtime-dialog-knobs.ts";

const ctx = (): SlotHolder => ({ slots: createDetachedSlotStore(), sessionId: "s-knobs" });

/** A one-state dialog carrying whatever knobs a case is about. */
function knobbed(key: string, knobs: Record<string, unknown>) {
  return dialog(key, {
    initial: "here",
    states: {
      here: { ...knobs, on: { GO: "gone" } },
      gone: { final: true },
    },
  } as never);
}

describe("the two knobs nothing applies", () => {
  test("a per-state `voice` is warned about, naming the dialog and the state", () => {
    const logger = makeLogger();

    const live = reportDialogKnobs([knobbed("disclosure", { voice: "michael" })], logger);

    expect(live).toBe(false);
    const [message] = logger.warn.mock.calls[0] ?? [];
    expect(message).toContain('Dialog "disclosure" declares `voice` on state "here"');
    // The message has to say what to do instead, or it is a complaint.
    expect(message).toContain("agent({ voice })");
  });

  test("a per-state `keyterms` is warned about and points at `sttPrompt`", () => {
    const logger = makeLogger();

    reportDialogKnobs([knobbed("menu", { keyterms: ["Acme Rewards"] })], logger);

    expect(logger.warn.mock.calls[0]?.[0]).toContain("agent({ sttPrompt })");
  });

  test("it is reported ONCE per agent definition, not once per session", () => {
    const logger = makeLogger();
    // The same ARRAY twice is the same `agent.dialogs` across two sessions.
    const dialogs: readonly AnyDialog[] = [knobbed("once", { voice: "michael" })];

    reportDialogKnobs(dialogs, logger);
    reportDialogKnobs(dialogs, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("a dialog carrying neither is silent", () => {
    const logger = makeLogger();

    reportDialogKnobs([knobbed("plain", { instruction: "Say hello." })], logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("whether any state declares a knob the pipeline CAN apply", () => {
  test.each([
    ["bargeIn", { bargeIn: "off" }],
    ["toolChoice", { toolChoice: "required" }],
    ["temperature", { temperature: 0.2 }],
  ])("%s counts as live", (name, knobs) => {
    expect(reportDialogKnobs([knobbed(`live-${name}`, knobs)], makeLogger())).toBe(true);
  });

  test("instructions and deadlines alone are NOT live, so the transport is untouched", () => {
    const quiet = dialog("quiet", {
      initial: "waiting",
      states: {
        waiting: {
          instruction: "Wait.",
          timeout: { afterMs: 1000, send: "UP" },
          on: { UP: "done" },
        },
        done: { final: true },
      },
    });

    expect(reportDialogKnobs([quiet], makeLogger())).toBe(false);
  });
});

describe("what the active states ask of the turn", () => {
  test('`bargeIn: "off"` becomes an UNREACHABLE word threshold', () => {
    const knobs = mergeTurnKnobs([knobbed("off", { bargeIn: "off" })], ctx());

    expect(knobs).toEqual({ minBargeInWords: Number.POSITIVE_INFINITY });
  });

  test("the two-number form passes through, and an omitted half stays omitted", () => {
    const knobs = mergeTurnKnobs([knobbed("some", { bargeIn: { minWords: 5 } })], ctx());

    // ABSENT, not undefined: the transport falls back to the agent's own value,
    // and a present `undefined` would have overwritten it with nothing.
    expect(knobs).toEqual({ minBargeInWords: 5 });
    expect(knobs && "interruptionMinDurationMs" in knobs).toBe(false);
  });

  test('`bargeIn: "default"` contributes nothing', () => {
    expect(mergeTurnKnobs([knobbed("dflt", { bargeIn: "default" })], ctx())).toEqual({});
  });

  test("`voice` and `keyterms` are DROPPED rather than passed on", () => {
    const knobs = mergeTurnKnobs(
      [knobbed("inert", { voice: "michael", keyterms: ["Acme"], temperature: 0.3 })],
      ctx(),
    );

    expect(knobs).toEqual({ temperature: 0.3 });
  });

  test("two dialogs merge per KEY, last declaration winning", () => {
    const knobs = mergeTurnKnobs(
      [
        knobbed("first", { toolChoice: "required", temperature: 0.1 }),
        knobbed("second", { temperature: 0.9 }),
      ],
      ctx(),
    );

    // `toolChoice` survives from the first: last-writer-wins is per key, so a
    // dialog with an opinion about one knob does not erase another's.
    expect(knobs).toEqual({ toolChoice: "required", temperature: 0.9 });
  });

  test("a state that declares nothing yields `undefined`", () => {
    expect(mergeTurnKnobs([knobbed("bare", { instruction: "Hi." })], ctx())).toBeUndefined();
  });
});
