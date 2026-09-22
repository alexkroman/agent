// Copyright 2026 the AAI authors. MIT license.
// Push-to-talk — `AgentDef.turnDetection: "manual"`. Two halves, the shape
// `pipeline-user-turn-limit.test.ts` uses: the turn state's own rules (what is
// held, what is answered, what is dropped), driven directly; and the wiring
// through the transport, asserted on what was REPORTED, what the transcriber
// was SENT and what it was ASKED — never on an internal flag.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { inFlightReplyScript, makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import {
  AUTO_TURN_DETECTION,
  createManualTurn,
  MANUAL_COMMIT_FINAL_TIMEOUT_MS,
} from "./pipeline-manual-turn.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

function makeTurn(): {
  turn: ReturnType<typeof createManualTurn>;
  committed: string[];
  forced: { count: number };
} {
  const committed: string[] = [];
  const forced = { count: 0 };
  const turn = createManualTurn("manual", {
    forceEndOfTurn: () => {
      forced.count++;
    },
    commitUserTurn: (text) => committed.push(text),
    isActive: () => true,
    log: silentLogger,
    sid: "s1",
  });
  return { turn, committed, forced };
}

describe("createManualTurn", () => {
  test("an agent that did not ask for it gets the inert policy", () => {
    const noop = { forceEndOfTurn: vi.fn(), commitUserTurn: vi.fn(), isActive: () => true };
    const deps = { ...noop, log: silentLogger, sid: "s" };
    expect(createManualTurn(undefined, deps)).toBe(AUTO_TURN_DETECTION);
    expect(createManualTurn("auto", deps)).toBe(AUTO_TURN_DETECTION);
    // Inert means the microphone is always open: nothing is silenced.
    expect(AUTO_TURN_DETECTION.isOpen()).toBe(true);
  });

  test("the microphone is open only between a start and its commit or clear", () => {
    const { turn } = makeTurn();
    expect(turn.isOpen()).toBe(false);
    turn.start();
    expect(turn.isOpen()).toBe(true);
    turn.commit();
    expect(turn.isOpen()).toBe(false);
    turn.start();
    turn.clear();
    expect(turn.isOpen()).toBe(false);
  });

  test("finals across pauses are HELD and answered as one turn at the commit", () => {
    const { turn, committed, forced } = makeTurn();
    turn.start();
    turn.onPartial("I'd like");
    turn.onFinal("I'd like a table.");
    turn.onPartial("For four");
    turn.onFinal("For four, at eight.");
    // Held, not answered: the caller is still holding the button.
    expect(committed).toEqual([]);
    // The caption is the WHOLE held turn plus the live partial.
    expect(turn.onPartial("On the")).toBe("I'd like a table. For four, at eight. On the");
    turn.onFinal("On the terrace.");

    turn.commit();
    // Nothing was outstanding, so nothing was forced and nothing waited.
    expect(forced.count).toBe(0);
    expect(committed).toEqual(["I'd like a table. For four, at eight. On the terrace."]);
  });

  test("a release mid-utterance forces the transcriber and answers on its final", () => {
    const { turn, committed, forced } = makeTurn();
    turn.start();
    turn.onFinal("Book it");
    turn.onPartial("for tomor");
    turn.commit();
    expect(forced.count).toBe(1);
    expect(committed).toEqual([]);

    turn.onFinal("for tomorrow.");
    expect(committed).toEqual(["Book it for tomorrow."]);
  });

  test("a final that never comes is answered on the last partial after the deadline", async () => {
    const { turn, committed } = makeTurn();
    turn.start();
    turn.onPartial("what time do you");
    turn.commit();
    await vi.advanceTimersByTimeAsync(MANUAL_COMMIT_FINAL_TIMEOUT_MS - 1);
    expect(committed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(committed).toEqual(["what time do you"]);

    // The late final is the same words: dropped, never folded into the next turn.
    turn.onFinal("What time do you close?");
    turn.start();
    turn.onFinal("Thanks.");
    turn.commit();
    expect(committed).toEqual(["what time do you", "Thanks."]);
  });

  test("clear discards the turn, and its tail final cannot open the next one", () => {
    const { turn, committed, forced } = makeTurn();
    turn.start();
    turn.onFinal("Actually,");
    turn.onPartial("never mi");
    turn.clear();
    expect(forced.count).toBe(1);

    // Pressed again BEFORE the discarded utterance's final landed.
    turn.start();
    turn.onFinal("never mind.");
    turn.onPartial("What's");
    turn.onFinal("What's the weather?");
    turn.commit();
    expect(committed).toEqual(["What's the weather?"]);
  });

  test("a final outside any turn is dropped, and a commit with nothing said answers nothing", () => {
    const { turn, committed } = makeTurn();
    turn.onFinal("room noise");
    expect(turn.onPartial("more noise")).toBeUndefined();
    turn.start();
    turn.commit();
    expect(committed).toEqual([]);
  });

  test("pressing again while a commit waits answers the first turn rather than merging them", () => {
    const { turn, committed } = makeTurn();
    turn.start();
    turn.onPartial("first thing");
    turn.commit();
    turn.start();
    expect(committed).toEqual(["first thing"]);
    turn.onPartial("second thing");
    turn.onFinal("Second thing.");
    turn.commit();
    expect(committed).toEqual(["first thing", "Second thing."]);
  });
});

describe("push-to-talk through the pipeline transport", () => {
  function manualTransport(
    llmScript: ReturnType<typeof inFlightReplyScript> = [{ type: "text", text: "ok" }],
  ) {
    const made = makeOpts({
      llm: createFakeLanguageModel({ script: llmScript, delayMs: 20 }),
      turnDetection: "manual",
    });
    return { ...made, t: createPipelineTransport(made.opts) };
  }

  test("audio outside the window reaches the transcriber as silence", async () => {
    const { t, stt } = manualTransport();
    await t.start();
    const frame = new Uint8Array([1, 0, 2, 0, 3, 0]);

    t.sendUserAudio(frame);
    t.startUserTurn?.();
    t.sendUserAudio(frame);
    t.commitUserTurn?.();
    t.sendUserAudio(frame);

    const frames = stt.last()?.audioFrames.map((pcm) => Array.from(pcm));
    expect(frames).toEqual([
      [0, 0, 0],
      [1, 2, 3],
      [0, 0, 0],
    ]);
    await t.stop();
  });

  test("a held turn is committed once, as one transcript, and then answered", async () => {
    const { t, stt, callbacks } = manualTransport();
    await t.start();

    t.startUserTurn?.();
    stt.last()?.firePartial("I need");
    stt.last()?.fireFinal("I need a cab.");
    stt.last()?.firePartial("To the");
    stt.last()?.fireFinal("To the airport.");
    await vi.advanceTimersByTimeAsync(100);
    // Nothing answered while the button is held.
    expect(callbacks.reported("user-transcript.committed")).not.toHaveBeenCalled();
    // The caption spans the pause.
    expect(callbacks.reported("user-transcript.updated")).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "I need a cab. To the" }),
    );

    t.commitUserTurn?.();
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledTimes(1);
    expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
      type: "user-transcript.committed",
      text: "I need a cab. To the airport.",
    });
    await t.stop();
  });

  test("speech does not barge in; opening a turn does", async () => {
    const { t, stt, tts, callbacks } = manualTransport(inFlightReplyScript());
    await t.start();
    t.startUserTurn?.();
    stt.last()?.fireFinal("Tell me a long story.");
    t.commitUserTurn?.();
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length ?? 0).toBeGreaterThan(0);
    });

    // SPOKEN, not merely started — barge-in gates on audio having gone out, so
    // without this the assertion below would hold under "auto" too.
    tts.last()?.fireAudio(new Int16Array(2400));
    // A loud room while the agent talks: under "auto" this is a barge-in.
    stt.last()?.firePartial("hey are you still there");
    expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();

    // The button is the interruption, and the transport says it interrupted.
    expect(t.startUserTurn?.()).toBe(true);
    // Opened into silence, it interrupts nothing and says so.
    t.clearUserTurn?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.startUserTurn?.()).toBe(false);
    await t.stop();
  });

  test("an auto agent ignores the verbs and says so once", async () => {
    const warn = vi.fn();
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      logger: { ...silentLogger, warn },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    expect(t.startUserTurn?.()).toBe(false);
    t.commitUserTurn?.();
    t.clearUserTurn?.();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/turnDetection: "manual"/);

    // And the transcriber still owns the turn: a final is answered as always.
    stt.last()?.fireFinal("hello");
    await vi.waitFor(() => {
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalled();
    });
    await t.stop();
  });
});
