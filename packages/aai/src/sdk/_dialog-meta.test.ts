// Copyright 2026 the AAI authors. MIT license.
/**
 * What a state's `meta` carries beyond the instruction — a deadline and the
 * per-phase voice settings — read back through `dialog()`, which is where an
 * author meets both.
 *
 * Two properties are the ones worth defending. The depth rule: the DEEPEST
 * active state that declares a setting supplies it, and a parent contributes
 * nothing to it, exactly as `instruction` has always worked. And backward
 * compatibility: none of this reaches the persisted snapshot, so a `durable`
 * dialog written before any of it existed resumes byte-identically — the
 * property the spec form was built on, and the one a new field is most likely
 * to break silently.
 */

import { describe, expect, test } from "vitest";
import { setup } from "xstate";
import { dialog } from "./dialog.ts";
import { createToolContext } from "./testing.ts";

describe("timeout", () => {
  const callSpec = {
    initial: "listening",
    states: {
      listening: {
        instruction: "Wait for them to read the policy number.",
        timeout: { afterMs: 20_000, send: "NUDGE" },
        on: { NUDGE: "prompting", HEARD: "done" },
      },
      prompting: { on: { HEARD: "done" } },
      done: { final: true },
    },
  } as const;

  test("reads the active state's declared deadline, as the event to send", () => {
    // The event object rather than the name: whatever arms this hands the result
    // straight back to `send` and never has to know how `timeout.send` is spelled.
    expect(dialog("call", callSpec).timeout(createToolContext())).toEqual({
      afterMs: 20_000,
      event: { type: "NUDGE" },
    });
  });

  test("is undefined where the state declares none", () => {
    const call = dialog("call", callSpec);
    const ctx = createToolContext();
    call.send(ctx, { type: "NUDGE" });
    expect(call.timeout(ctx)).toBeUndefined();
  });

  test("the DEEPEST declaring state wins over its parent", () => {
    const call = dialog("call", {
      initial: "verifying",
      states: {
        verifying: {
          timeout: { afterMs: 60_000, send: "GIVE_UP" },
          initial: "reading",
          on: { GIVE_UP: "done" },
          states: {
            reading: { timeout: { afterMs: 15_000, send: "GIVE_UP" }, on: { SLOW: "waiting" } },
            waiting: {},
          },
        },
        done: { final: true },
      },
    });
    const ctx = createToolContext();
    expect(call.timeout(ctx)?.afterMs).toBe(15_000);
    // ...and the parent's is what applies once the child declares none.
    call.send(ctx, { type: "SLOW" });
    expect(call.timeout(ctx)?.afterMs).toBe(60_000);
  });

  test("reads a hand-written machine's `meta.timeout` too", () => {
    const machine = setup({ types: {} as { events: { type: "NUDGE" } } }).createMachine({
      id: "call",
      initial: "listening",
      states: {
        listening: { meta: { timeout: { afterMs: 5000, send: "NUDGE" } }, on: { NUDGE: "done" } },
        done: { type: "final" },
      },
    });
    expect(dialog("call", machine).timeout(createToolContext())).toEqual({
      afterMs: 5000,
      event: { type: "NUDGE" },
    });
  });

  test("a nonsensical `afterMs` is no deadline at all", () => {
    // `meta` is `Record<string, any>` on the machine form, so the reader is the
    // only thing standing between a typo and a deadline nothing can honour.
    // `0` and a negative are both a deadline that has already passed; inventing
    // a meaning for either is worse than reporting none.
    const machine = setup({ types: {} as { events: { type: "NUDGE" } } }).createMachine({
      id: "call",
      initial: "listening",
      states: {
        listening: { meta: { timeout: { afterMs: 0, send: "NUDGE" } }, on: { NUDGE: "done" } },
        done: { type: "final" },
      },
    });
    expect(dialog("call", machine).timeout(createToolContext())).toBeUndefined();
  });
});

describe("voiceConfig", () => {
  const callSpec = {
    initial: "disclosure",
    states: {
      disclosure: {
        instruction: "Read the disclosure in full.",
        voice: "michael",
        bargeIn: "off",
        on: { READ: "collecting" },
      },
      collecting: {
        keyterms: ["policy number", "excess"],
        bargeIn: { minWords: 1, minDurationMs: 100 },
        toolChoice: "required",
        temperature: 0.2,
        on: { GOT: "done" },
      },
      done: { final: true },
    },
  } as const;

  test("answers the active state's declared knobs, and only those", () => {
    expect(dialog("call", callSpec).voiceConfig(createToolContext())).toEqual({
      voice: "michael",
      bargeIn: "off",
    });
  });

  test("carries every knob a state declares", () => {
    const call = dialog("call", callSpec);
    const ctx = createToolContext();
    call.send(ctx, { type: "READ" });
    expect(call.voiceConfig(ctx)).toEqual({
      keyterms: ["policy number", "excess"],
      bargeIn: { minWords: 1, minDurationMs: 100 },
      toolChoice: "required",
      temperature: 0.2,
    });
  });

  test("is undefined where no state in force declares any of them", () => {
    const call = dialog("call", callSpec);
    const ctx = createToolContext();
    call.send(ctx, { type: "READ" });
    call.send(ctx, { type: "GOT" });
    expect(call.voiceConfig(ctx)).toBeUndefined();
  });

  test("the DEEPEST declaring state wins WHOLE — a parent's knobs are not merged in", () => {
    // Per declaration rather than per field: a phase that pins `voice` and
    // `bargeIn` together means them together, and a merge would hand a
    // disclosure state its parent's interruptible barge-in while honouring its
    // own voice.
    const call = dialog("call", {
      initial: "serving",
      states: {
        serving: {
          voice: "amy",
          temperature: 0.9,
          initial: "disclosing",
          on: { BAIL: "done" },
          states: {
            disclosing: { bargeIn: "off", on: { READ: "chatting" } },
            chatting: {},
          },
        },
        done: { final: true },
      },
    });
    const ctx = createToolContext();
    expect(call.voiceConfig(ctx)).toEqual({ bargeIn: "off" });
    // The parent's is what applies once the child declares nothing.
    call.send(ctx, { type: "READ" });
    expect(call.voiceConfig(ctx)).toEqual({ voice: "amy", temperature: 0.9 });
  });

  test("a knob of the wrong shape is dropped, not passed through", () => {
    // Same reasoning as `afterMs`: on the machine form `meta` is untyped, and a
    // TTS voice of `42` is a value no provider can be handed.
    const machine = setup({ types: {} as { events: { type: "GO" } } }).createMachine({
      id: "call",
      initial: "greeting",
      states: {
        greeting: {
          meta: { voice: 42, keyterms: ["policy", 7], bargeIn: "off" },
          on: { GO: "done" },
        },
        done: { type: "final" },
      },
    });
    expect(dialog("call", machine).voiceConfig(createToolContext())).toEqual({ bargeIn: "off" });
  });
});

describe("backward compatibility", () => {
  /** The dialog as it was before any of these fields existed. */
  const plainSpec = {
    initial: "verifying",
    states: {
      verifying: { instruction: "Verify the policy number.", on: { VERIFIED: "quoting" } },
      quoting: { instruction: "Quote it.", on: { QUOTED: "done" } },
      done: { final: true },
    },
  } as const;

  test("a spec using none of the new fields stores exactly what it stored before", () => {
    const call = dialog("call", plainSpec);
    const ctx = createToolContext();
    call.send(ctx, { type: "VERIFIED" });
    // The whole persisted value, not a subset: what a `durable` slot round-trips
    // through JSON is this object, and a field that leaked into it would be a
    // resume that silently reads a snapshot it did not write.
    expect(JSON.parse(JSON.stringify(ctx.slots.read("call")))).toEqual({
      snapshot: { status: "active", value: "quoting", historyValue: {}, context: {}, children: {} },
    });
  });

  test("declaring the new fields does not change the stored snapshot either", () => {
    // `meta` belongs to the machine DEFINITION, not to the snapshot, which is
    // why these settings cost the stored value nothing and cannot go stale
    // against a session resumed onto a newer build.
    const ctx = createToolContext();
    dialog("call", plainSpec).send(ctx, { type: "VERIFIED" });
    const plain = JSON.parse(JSON.stringify(ctx.slots.read("call")));

    const richCtx = createToolContext();
    dialog("call", {
      initial: "verifying",
      states: {
        verifying: {
          instruction: "Verify the policy number.",
          voice: "amy",
          keyterms: ["policy number"],
          timeout: { afterMs: 30_000, send: "VERIFIED" },
          on: { VERIFIED: "quoting" },
        },
        quoting: { instruction: "Quote it.", bargeIn: "off", on: { QUOTED: "done" } },
        done: { final: true },
      },
    }).send(richCtx, { type: "VERIFIED" });
    expect(JSON.parse(JSON.stringify(richCtx.slots.read("call")))).toEqual(plain);
  });

  test("a session persisted by the plain dialog resumes in the enriched one", () => {
    // Both occupy the key "call", so both read the same slot in this one
    // context — the same property the spec form was introduced on.
    const ctx = createToolContext();
    dialog("call", plainSpec).send(ctx, { type: "VERIFIED" });
    const enriched = dialog("call", {
      initial: "verifying",
      states: {
        verifying: { instruction: "Verify the policy number.", on: { VERIFIED: "quoting" } },
        quoting: {
          instruction: "Quote it.",
          voice: "michael",
          timeout: { afterMs: 45_000, send: "QUOTED" },
          on: { QUOTED: "done" },
        },
        done: { final: true },
      },
    });
    expect(enriched.position(ctx)).toMatchObject({ state: "quoting", instruction: "Quote it." });
    expect(enriched.timeout(ctx)).toEqual({ afterMs: 45_000, event: { type: "QUOTED" } });
    expect(enriched.voiceConfig(ctx)).toEqual({ voice: "michael" });
  });
});
