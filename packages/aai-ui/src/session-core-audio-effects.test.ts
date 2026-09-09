// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the session core's side of the audio path.
 *
 * The machine decides WHEN; these are the HOWs, and every one of them is a
 * write to something the machine cannot see — a socket frame, the snapshot,
 * the turn epoch. The drain guard is the load-bearing one: `done()` also
 * resolves when the AudioContext stops rendering, so a reply's completion can
 * land long after the turn, or the whole session, is over.
 */

import { createEpoch } from "@alexkroman1/aai/internal";
import type { SessionCommand } from "@alexkroman1/aai/protocol";
import { describe, expect, it, vi } from "vitest";
import { tick } from "./_react-test-utils.ts";
import type { VoiceIO } from "./audio.ts";
import { createAudioEffects } from "./session-core-audio-effects.ts";
import { createSessionStateMachine } from "./session-core-state.ts";
import type { ConnState, SessionSnapshot } from "./session-core-types.ts";

function harness() {
  const conn: ConnState = { ws: null, retiredByServer: false, turn: createEpoch() };
  const agentState = createSessionStateMachine();
  const writes: Partial<SessionSnapshot>[] = [];
  const sent: SessionCommand[] = [];
  const effects = createAudioEffects({
    conn,
    updateState: (partial) => writes.push(partial),
    agentState,
    sendJson: (msg) => sent.push(msg),
    sendAudio: vi.fn(),
  });
  return { conn, agentState, effects, writes, sent };
}

/** A path whose drain the test settles by hand. */
function makeIO(
  done: Promise<void>,
  close: () => Promise<void> = () => Promise.resolve(),
): VoiceIO {
  const io: VoiceIO = {
    enqueue: vi.fn(),
    done: () => done,
    flush: vi.fn(),
    close: vi.fn(close),
    async [Symbol.asyncDispose]() {
      await io.close();
    },
  };
  return io;
}

describe("createAudioEffects", () => {
  it("announces a live mic on the wire and in the snapshot", () => {
    const { effects, writes, sent } = harness();

    effects.announceReady();
    effects.micLive();

    expect(sent).toEqual([{ type: "audio_ready" }]);
    expect(writes).toEqual([{ recording: true }]);
  });

  it("reports playback depth, and swallows a report the socket cannot take", () => {
    const { conn, agentState, effects } = harness();
    effects.reportProgress(120);

    // A closed socket is the ordinary case during teardown: the report is
    // advisory (the host clamps upward only), so it must not throw into the
    // worklet's callback.
    const closed = createAudioEffects({
      conn,
      updateState: () => undefined,
      agentState,
      sendJson: () => {
        throw new Error("socket closed");
      },
      sendAudio: () => {
        throw new Error("socket closed");
      },
    });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    expect(() => closed.reportProgress(120)).not.toThrow();
    expect(() => closed.sendMicAudio(new ArrayBuffer(4))).not.toThrow();
    debug.mockRestore();
  });

  it("a drain that lands within its turn goes back to listening", async () => {
    const { effects, writes } = harness();
    const drain = Promise.withResolvers<void>();

    effects.settleWhenDrained(makeIO(drain.promise));
    drain.resolve();
    await tick();

    expect(writes).toEqual([{ state: "listening", error: null }]);
  });

  it("a drain that lands after a turn boundary is discarded", async () => {
    const { conn, effects, writes } = harness();
    const drain = Promise.withResolvers<void>();
    effects.settleWhenDrained(makeIO(drain.promise));

    // A barge-in, a committed user turn, or an audio-path teardown. Without
    // this guard the continuation writes `state: "listening"` over a session
    // that has since gone disconnected or errored — a dead session claiming a
    // live mic.
    conn.turn.bump();
    drain.resolve();
    await tick();

    expect(writes).toEqual([]);
  });

  it("a drain that rejects is logged, not thrown", async () => {
    const { effects, writes } = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const drain = Promise.withResolvers<void>();

    effects.settleWhenDrained(makeIO(drain.promise));
    drain.reject(new Error("worklet gone"));
    await tick();

    expect(warn).toHaveBeenCalled();
    expect(writes).toEqual([]);
    warn.mockRestore();
  });

  it("an audio failure is a NON-fatal banner that stops the mic", () => {
    const { agentState, effects, writes } = harness();

    effects.reportFailure("Microphone access failed: Permission denied");

    expect(writes).toEqual([
      {
        state: "error",
        error: {
          code: "audio",
          message: "Microphone access failed: Permission denied",
          fatal: false,
        },
        running: false,
        recording: false,
      },
    ]);
    // Not fatal: the socket may well still be fine, so a later server frame is
    // allowed to retire this banner.
    expect(agentState.fatal()).toBe(false);
  });

  it("ending a turn invalidates a drain captured before it", () => {
    const { conn, effects } = harness();
    const at = conn.turn.current();

    effects.endTurn();

    expect(conn.turn.isCurrent(at)).toBe(false);
  });

  it("releasing a path swallows a close that fails", async () => {
    const { effects } = harness();
    const io = makeIO(Promise.resolve(), () => Promise.reject(new Error("already closing")));

    expect(() => effects.release(io)).not.toThrow();
    await tick();

    expect(io.close).toHaveBeenCalledOnce();
  });
});
