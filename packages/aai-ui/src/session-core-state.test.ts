// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the browser session's state statechart.
 *
 * The session-core suites drive the same rules through a socket, which is right
 * — they are what proves the wiring. These state the INVARIANTS directly, the
 * ones that were previously enforced by every writer remembering to read the
 * snapshot back first: what a fatal session refuses, and which state pairs
 * cannot occur.
 */

import { describe, expect, it } from "vitest";
import { createSessionStateMachine } from "./session-core-state.ts";
import type { SessionError } from "./types.ts";

const FATAL: SessionError = {
  code: "internal",
  message: "Cartesia TTS: missing API key.",
  fatal: true,
};
const TURN: SessionError = {
  code: "internal",
  message: "one upload failed to transcribe",
  fatal: false,
};

/** A session that has reached `listening` the way a real one does. */
function live() {
  const machine = createSessionStateMachine();
  machine.apply({ type: "CONNECT" });
  machine.apply({ type: "SOCKET_OPEN" });
  machine.apply({ type: "HANDSHAKE_COMPLETE" });
  machine.apply({ type: "LISTEN" });
  return machine;
}

describe("createSessionStateMachine", () => {
  it("starts disconnected with no error", () => {
    expect(createSessionStateMachine().snapshot()).toEqual({ state: "disconnected", error: null });
  });

  it("walks a connect through to listening", () => {
    const machine = createSessionStateMachine();
    expect(machine.apply({ type: "CONNECT" }).state).toBe("connecting");
    expect(machine.apply({ type: "SOCKET_OPEN" }).state).toBe("ready");
    expect(machine.apply({ type: "LISTEN" }).state).toBe("listening");
    expect(machine.apply({ type: "THINK" }).state).toBe("thinking");
    expect(machine.apply({ type: "SPEAK" }).state).toBe("speaking");
    expect(machine.apply({ type: "LISTEN" }).state).toBe("listening");
  });

  it("a turn-level failure is a banner over a session that keeps running", () => {
    const machine = live();

    expect(machine.apply({ type: "TURN_ERROR", error: TURN })).toEqual({
      state: "listening",
      error: TURN,
    });
    expect(machine.fatal()).toBe(false);
  });

  it("a non-error frame retires a turn-level banner", () => {
    const machine = live();
    machine.apply({ type: "TURN_ERROR", error: TURN });

    expect(machine.apply({ type: "ACTIVITY" })).toEqual({ state: "listening", error: null });
  });

  it("a non-error frame recovers a non-fatal error to listening, not disconnected", () => {
    const machine = live();
    machine.apply({ type: "FAILED", error: TURN });
    expect(machine.snapshot().state).toBe("error");

    // The socket is demonstrably open — we are handling a server event — so
    // "disconnected" would misreport a live session.
    expect(machine.apply({ type: "ACTIVITY" })).toEqual({ state: "listening", error: null });
  });

  describe("a fatal session", () => {
    it("refuses every frame that would paint a working state over its banner", () => {
      const machine = live();
      machine.apply({ type: "FATAL", error: FATAL });
      const dead = { state: "error", error: FATAL };

      // All five used to be written by callers that had to remember to consult
      // `conn.fatalError` first; one of them (THINK) did not.
      expect(machine.apply({ type: "ACTIVITY" })).toEqual(dead);
      expect(machine.apply({ type: "LISTEN" })).toEqual(dead);
      expect(machine.apply({ type: "THINK" })).toEqual(dead);
      expect(machine.apply({ type: "SPEAK" })).toEqual(dead);
      expect(machine.apply({ type: "RESET" })).toEqual(dead);
    });

    it("keeps its banner through the close that follows", () => {
      const machine = live();
      machine.apply({ type: "FATAL", error: FATAL });

      // Downgrading to "disconnected" would hide why the session ended.
      expect(machine.apply({ type: "CLOSED" })).toEqual({ state: "error", error: FATAL });
    });

    it("keeps its banner through a hang-up, which reports the phase honestly", () => {
      const machine = live();
      machine.apply({ type: "FATAL", error: FATAL });

      expect(machine.apply({ type: "DISCONNECT" })).toEqual({
        state: "disconnected",
        error: FATAL,
      });
    });

    it("does not let a straggler chunk play over the banner it left behind", () => {
      const machine = live();
      machine.apply({ type: "FATAL", error: FATAL });
      machine.apply({ type: "DISCONNECT" });

      // `disconnected` DOES admit a chunk — but only with no banner up.
      expect(machine.apply({ type: "SPEAK" }).state).toBe("disconnected");
    });

    it("is superseded by a completed handshake, per connection", () => {
      const machine = live();
      machine.apply({ type: "FATAL", error: FATAL });

      // The latch outlives the `error` phase, which is why it is its own
      // region: a reconnect runs connecting → ready while still latched.
      expect(machine.apply({ type: "CONNECT" })).toEqual({ state: "connecting", error: null });
      expect(machine.fatal()).toBe(true);
      expect(machine.apply({ type: "SOCKET_OPEN" }).state).toBe("ready");
      expect(machine.fatal()).toBe(true);

      machine.apply({ type: "HANDSHAKE_COMPLETE" });

      expect(machine.fatal()).toBe(false);
      expect(machine.apply({ type: "LISTEN" }).state).toBe("listening");
    });
  });

  it("a clean close retires a lingering non-fatal banner", () => {
    const machine = live();
    machine.apply({ type: "TURN_ERROR", error: TURN });

    expect(machine.apply({ type: "CLOSED" })).toEqual({ state: "disconnected", error: null });
  });

  it("a hang-up keeps a non-fatal banner — it explains why the session ended", () => {
    const machine = live();
    machine.apply({ type: "TURN_ERROR", error: TURN });

    expect(machine.apply({ type: "DISCONNECT" })).toEqual({
      state: "disconnected",
      error: TURN,
    });
  });

  it("end() clears everything — a later start is a new session", () => {
    const machine = live();
    machine.apply({ type: "FATAL", error: FATAL });

    expect(machine.apply({ type: "END" })).toEqual({ state: "disconnected", error: null });
  });

  it("an errored phase never carries a null error", () => {
    const machine = live();
    // The pair `fuzz-session-core.test.ts` reports as "error state carries no
    // error", and the one this machine exists to make unrepresentable.
    for (const event of [
      { type: "ACTIVITY" },
      { type: "LISTEN" },
      { type: "THINK" },
      { type: "SPEAK" },
      { type: "RESET" },
      { type: "CLOSED" },
      { type: "DISCONNECT" },
      { type: "SOCKET_OPEN" },
    ] as const) {
      machine.apply({ type: "FATAL", error: FATAL });
      const after = machine.apply(event);
      if (after.state === "error") expect(after.error).not.toBeNull();
    }
  });
});
