// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things that move a dialog without a tool call — a session event, and
 * time — driven through `dialog()`, which is the only way an author reaches
 * either.
 *
 * The declaration guards carry most of the weight here, and each one exists
 * because the failure it catches is SILENT at run time: XState stores an event
 * name it will never match, ignores an event nothing handles, and desugars a
 * delay into a transition that reads as a healthy exit. Every one of those is a
 * dialog that runs, reports plausible positions, and never moves.
 */

import { describe, expect, test } from "vitest";
import { setup } from "xstate";
import { dialog } from "./dialog.ts";
import { createToolContext } from "./testing.ts";

/** A call that can be abandoned by the caller as well as finished by the agent. */
const callSpec = {
  initial: "greeting",
  states: {
    greeting: {
      instruction: "Say hello and ask what they need.",
      on: { HEARD: "helping", "@session.timed-out": "abandoned" },
    },
    helping: {
      instruction: "Help them.",
      on: { DONE: "closed", "@session.timed-out": "abandoned" },
    },
    abandoned: { final: true },
    closed: { final: true },
  },
} as const;

describe("session-event transitions", () => {
  test("an `@` name that is not a session event is refused at declaration", () => {
    // The typo this exists for: XState accepts the name, stores it, and never
    // matches it, so the state meant to catch a dead call is never entered.
    expect(() =>
      dialog("call", {
        initial: "greeting",
        states: {
          greeting: { on: { "@session.timedout": "abandoned" } },
          abandoned: { final: true },
        },
      }),
    ).toThrow(/"@session.timedout".*is not a session event/s);
  });

  test("the refusal names the state and lists the real event names", () => {
    expect(() =>
      dialog("call", {
        initial: "greeting",
        states: {
          greeting: { on: { "@speech.begun": "abandoned" } },
          abandoned: { final: true },
        },
      }),
    ).toThrow(/state "greeting".*@session\.timed-out/s);
  });

  test("the same check runs on a hand-written machine", () => {
    // Read off the COMPILED machine, so one walk covers both overloads.
    const machine = setup({ types: {} as { events: { type: "@nope.happened" } } }).createMachine({
      id: "call",
      initial: "greeting",
      states: {
        greeting: { on: { "@nope.happened": "abandoned" } },
        abandoned: { type: "final" },
      },
    });
    expect(() => dialog("call", machine)).toThrow(/"@nope.happened"/);
  });

  test("a real session event name is accepted", () => {
    expect(() => dialog("call", callSpec)).not.toThrow();
  });
});

describe("receive", () => {
  test("moves the dialog when the active state declares the event", () => {
    const call = dialog("call", callSpec);
    const ctx = createToolContext();
    const at = call.receive(ctx, { type: "session.timed-out", meta: { id: "evt_1", at: 0 } });
    expect(at).toMatchObject({ state: "abandoned", done: true });
    expect(call.position(ctx).state).toBe("abandoned");
  });

  test("is a no-op for an event the dialog does not handle", () => {
    const call = dialog("call", callSpec);
    const ctx = createToolContext();
    const at = call.receive(ctx, { type: "reply.completed", meta: { id: "evt_1", at: 0 } });
    expect(at.state).toBe("greeting");
    expect(call.position(ctx).state).toBe("greeting");
  });

  test("an unhandled event WRITES NOTHING, where a send would write every time", () => {
    // The reason `receive` asks before it sends, and the measurement is the
    // whole argument: a session emits transcript and speech frames continuously,
    // and a send stores the snapshot whether or not the machine moved — so on a
    // durable dialog, sending every event would be a store round-trip per frame.
    const ctx = createToolContext();
    let writes = 0;
    const counted = {
      sessionId: ctx.sessionId,
      slots: {
        read: (key: string) => ctx.slots.read(key),
        write: (key: string, value: unknown, durable: boolean) => {
          writes += 1;
          ctx.slots.write(key, value, durable);
        },
      },
    };
    const call = dialog("call", callSpec);
    // The first read materializes the slot's default, as every read does.
    call.position(counted);
    writes = 0;

    for (const type of ["speech.started", "speech.stopped", "reply.completed"] as const) {
      call.receive(counted, { type, meta: { id: "evt_1", at: 0 } });
    }
    expect(writes).toBe(0);

    call.receive(counted, { type: "session.timed-out", meta: { id: "evt_1", at: 0 } });
    expect(writes).toBe(1);
  });

  test("a transition declared on a PARENT fires from a nested state", () => {
    // `can()` is XState's own answer to "would this do anything here", so an
    // ancestor's `on` is honoured exactly as it would be by `send`.
    const call = dialog("call", {
      initial: "working",
      states: {
        working: {
          initial: "triaging",
          on: { "@session.timed-out": "abandoned" },
          states: { triaging: {} },
        },
        abandoned: { final: true },
      },
    });
    const ctx = createToolContext();
    expect(call.position(ctx).state).toBe("working.triaging");
    const at = call.receive(ctx, { type: "session.timed-out", meta: { id: "evt_1", at: 0 } });
    expect(at.state).toBe("abandoned");
  });

  test("two sessions receive independently", () => {
    const call = dialog("call", callSpec);
    const alice = createToolContext();
    const bob = createToolContext();
    call.receive(alice, { type: "session.timed-out", meta: { id: "evt_1", at: 0 } });
    expect(call.position(alice).state).toBe("abandoned");
    expect(call.position(bob).state).toBe("greeting");
  });

  test("the position it answers carries the instruction of where it landed", () => {
    const call = dialog("call", callSpec);
    const ctx = createToolContext();
    call.send(ctx, { type: "HEARD" });
    const at = call.receive(ctx, { type: "reply.completed", meta: { id: "evt_1", at: 0 } });
    expect(at).toMatchObject({ state: "helping", instruction: "Help them." });
  });
});

describe("delayed transitions", () => {
  /**
   * A state declaring `after` is not a shape {@link DialogStateSpec} describes,
   * so it is named separately rather than written inline: as a fresh literal at
   * the call it is a compile error, and what this test is about is the RUNTIME
   * guard — the one a JavaScript author, or an author who reached this through
   * a machine, actually meets.
   */
  const waiting = { instruction: "Wait for them.", after: { 1000: "done" } };

  test("a spec declaring `after` is refused, and the message names `timeout`", () => {
    expect(() =>
      dialog("call", { initial: "waiting", states: { waiting, done: { final: true } } }),
    ).toThrow(/`after`.*`timeout: \{ afterMs, send \}`/s);
  });

  test("the refusal explains WHY, because the transition looks legal", () => {
    expect(() =>
      dialog("call", { initial: "waiting", states: { waiting, done: { final: true } } }),
    ).toThrow(/synchronous window/);
  });

  test("a nested state's `after` is refused too, named by its dotted path", () => {
    expect(() =>
      dialog("call", {
        initial: "outer",
        states: {
          outer: { initial: "inner", on: { GO: "done" }, states: { inner: waiting } },
          done: { final: true },
        },
      }),
    ).toThrow(/state "outer.inner"/);
  });

  test("a machine using `after` is refused, and pointed at `timeout`/`procedure()`", () => {
    // The case that used to PASS every check in this package: XState desugars a
    // delay into the transitions map, so the graph guard read it as a healthy
    // exit — its own fixture asserted exactly this shape was fine.
    const machine = setup({}).createMachine({
      id: "call",
      initial: "waiting",
      states: { waiting: { after: { 1000: "done" } }, done: { type: "final" } },
    });
    expect(() => dialog("call", machine)).toThrow(/`after`.*procedure\(\)/s);
  });

  test("that refusal comes BEFORE the graph guard's, which would misdescribe it", () => {
    // With the delay dropped, `waiting` has no way out and the graph guard would
    // say "give it an outgoing event" to an author who wrote one.
    expect(() =>
      dialog("call", { initial: "waiting", states: { waiting, done: { final: true } } }),
    ).not.toThrow(/can never leave/);
  });
});

describe("declared timeouts", () => {
  test("a `timeout.send` naming an event nothing handles is refused", () => {
    expect(() =>
      dialog("call", {
        initial: "waiting",
        states: {
          waiting: { timeout: { afterMs: 30_000, send: "GIVE_UP" }, on: { HEARD: "done" } },
          done: { final: true },
        },
      }),
    ).toThrow(/timeout sending "GIVE_UP"/);
  });

  test("the refusal says what it would cost: a deadline that fires into silence", () => {
    expect(() =>
      dialog("call", {
        initial: "waiting",
        states: {
          waiting: { timeout: { afterMs: 30_000, send: "GIVE_UP" }, on: { HEARD: "done" } },
          done: { final: true },
        },
      }),
    ).toThrow(/fire and be ignored/);
  });

  test("an event the state's own `on` declares is accepted", () => {
    expect(() =>
      dialog("call", {
        initial: "waiting",
        states: {
          waiting: { timeout: { afterMs: 30_000, send: "GIVE_UP" }, on: { GIVE_UP: "done" } },
          done: { final: true },
        },
      }),
    ).not.toThrow();
  });

  test("an event a CONTAINING state declares is accepted too", () => {
    // Being in a state is being in all of them, which is the rule the graph
    // guard's `hasExit` already had to learn: refusing this would make the check
    // a source of false alarms on dialogs that work.
    expect(() =>
      dialog("call", {
        initial: "working",
        states: {
          working: {
            initial: "triaging",
            on: { GIVE_UP: "done" },
            states: { triaging: { timeout: { afterMs: 30_000, send: "GIVE_UP" } } },
          },
          done: { final: true },
        },
      }),
    ).not.toThrow();
  });

  test("a hand-written `meta.timeout` is checked the same way", () => {
    const machine = setup({ types: {} as { events: { type: "HEARD" } } }).createMachine({
      id: "call",
      initial: "waiting",
      states: {
        waiting: { meta: { timeout: { afterMs: 30_000, send: "GIVE_UP" } }, on: { HEARD: "done" } },
        done: { type: "final" },
      },
    });
    expect(() => dialog("call", machine)).toThrow(/timeout sending "GIVE_UP"/);
  });
});
