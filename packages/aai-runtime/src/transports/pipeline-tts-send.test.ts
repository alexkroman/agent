// Copyright 2026 the AAI authors. MIT license.
// The session's raw TTS send: the four things it does per send, and the one
// measurement that reads its clock.
//
// Split out of `pipeline-transport.ts` with the module, and these are the
// claims that were previously made only through a whole transport — the audio
// gate opening, the ASCII fold being LENGTH-PRESERVING (which is what lets the
// heard cursor index the same positions), the caption opt-out, and `TTS first
// audio` firing once per reply rather than per sentence.

import { describe, expect, test } from "vitest";
import { makeLogger } from "../_test-utils.ts";
import { createHeardTracker } from "./pipeline-heard.ts";
import { createTtsSender } from "./pipeline-tts-send.ts";
import { createTurnMachine } from "./pipeline-turn-state.ts";

function harness() {
  const sentToProvider: string[] = [];
  const reported: { type: string; text?: string }[] = [];
  const log = makeLogger();
  const turns = createTurnMachine();
  const heard = createHeardTracker({ sampleRate: 24_000, lagMs: 0 });
  const sender = createTtsSender({
    turns,
    heard,
    tts: () => ({ sendText: (text) => sentToProvider.push(text) }),
    callbacks: { report: (event) => reported.push(event as { type: string; text?: string }) },
    log,
    sid: "s",
  });
  return { sender, sentToProvider, reported, log, turns, heard };
}

describe("createTtsSender", () => {
  test("opens the audio gate, so a fresh turn's audio is not dropped", () => {
    // The gate is CLOSED by a barge-in (`interrupt`), which is when this
    // matters: the next reply's first send is what reopens it.
    const { sender, turns } = harness();
    turns.interrupt();
    expect(turns.audioGateOpen()).toBe(false);
    sender.send("Hello.");
    expect(turns.audioGateOpen()).toBe(true);
  });

  test("ASCII-folds for the engine, and the fold is LENGTH-PRESERVING", () => {
    // The heard cursor indexes positions in what was SENT, so a fold that
    // changed the length would silently mis-truncate an interrupted reply.
    const { sender, sentToProvider } = harness();
    const text = "I’ll check that “now”.";
    sender.send(text);
    expect(sentToProvider[0]).toBe(`I'll check that "now".`);
    expect(sentToProvider[0]?.length).toBe(text.length);
  });

  test("publishes the interim caption by default, with the tail as it grows", () => {
    const { sender, reported } = harness();
    sender.send("Hello. ");
    sender.send("How are you?");
    expect(reported).toEqual([
      { type: "agent-transcript.updated", text: "Hello. " },
      { type: "agent-transcript.updated", text: "Hello. How are you?" },
    ]);
  });

  test("`publishTranscript: false` skips the caption and still advances the tail", () => {
    // The greeting and the start-failure line publish their own final.
    const { sender, reported, heard } = harness();
    sender.send("Welcome.", { publishTranscript: false });
    expect(reported).toEqual([]);
    sender.send("Anything else?");
    expect(reported).toEqual([
      { type: "agent-transcript.updated", text: "Welcome.Anything else?" },
    ]);
    // The tail is the cursor's, so the skipped line is still part of what the
    // caller heard — which is what feeds the tail-resume estimate.
    expect(heard.spokeRecordable()).toBe(true);
  });

  test("`record: false` marks filler, which the heard cursor refuses to record", () => {
    const { sender, heard } = harness();
    sender.send("One moment.", { record: false });
    // Audible — it moved the cursor — and not recordable, the flag the
    // barge-in gate reads.
    expect(heard.spokeRecordable()).toBe(false);
  });

  test("`TTS first audio` is logged ONCE per reply, timed from the first send", () => {
    const { sender, log } = harness();
    sender.send("Hello.");
    sender.send("More.");
    sender.reportFirstAudio();
    sender.reportFirstAudio();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("TTS first audio", expect.objectContaining({ sid: "s" }));
  });

  test("reporting audio before any send says nothing", () => {
    const { sender, log } = harness();
    sender.reportFirstAudio();
    expect(log.info).not.toHaveBeenCalled();
  });

  test("a session with no TTS session yet still advances the cursor", () => {
    // `providers.tts` is null before `open()` and after a recovery, which is
    // why the sender reads it through a thunk per send.
    const turns = createTurnMachine();
    const heard = createHeardTracker({ sampleRate: 24_000, lagMs: 0 });
    const sender = createTtsSender({
      turns,
      heard,
      tts: () => null,
      callbacks: { report: () => undefined },
      log: makeLogger(),
      sid: "s",
    });
    expect(() => sender.send("Hello.")).not.toThrow();
    expect(heard.spokeRecordable()).toBe(true);
  });
});
