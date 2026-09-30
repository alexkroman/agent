// Copyright 2026 the AAI authors. MIT license.
// `speakLine` specs: the verb behind the SDK's `speech.say`. A line is spoken
// VERBATIM (no model call) as a reply of its own, queued on the turn chain, and
// `done` reports how it ended — played, cut after it started, or never started.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, createFakeTtsProvider } from "../_pipeline-test-fakes.ts";
import { makeOpts, spoken, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import type { SpokenLine } from "./types.ts";

useVirtualTime();

const LINE = "Your timer is done.";

/** A line's controls, with `onStart` recorded. */
function line(): SpokenLine & { takeBack: () => void; started: () => boolean } {
  const ctl = new AbortController();
  let started = false;
  return {
    signal: ctl.signal,
    onStart: () => {
      started = true;
    },
    takeBack: () => ctl.abort(),
    started: () => started,
  };
}

/** A transport whose TTS holds each line "playing" until the spec says `done`. */
async function holdingTransport() {
  const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
  const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Anything else?" }] });
  const { opts, callbacks } = makeOpts({ llm }, { tts });
  const t = createPipelineTransport(opts);
  await t.start();
  const finishPlaying = (): void => {
    tts.last()?.emitter.emit("done");
  };
  return { t, tts, llm, callbacks, finishPlaying };
}

describe("speakLine", () => {
  test("speaks the text verbatim, without calling the model, and reports it PLAYED", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "unused" }] });
    const { opts, tts, callbacks } = makeOpts({ llm });
    const t = createPipelineTransport(opts);
    await t.start();
    const controls = line();

    await expect(t.speakLine?.(LINE, controls)).resolves.toBe("played");

    expect(controls.started()).toBe(true);
    expect(spoken(tts)).toBe(LINE);
    expect(llm.calls).toHaveLength(0);
    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: LINE,
    });
    expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
    await t.stop();
  });

  test("a played line is in the model's history, so the next turn knows it was said", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Anything else?" }] });
    const { opts, callbacks } = makeOpts({ llm });
    const t = createPipelineTransport(opts);
    await t.start();

    await t.speakLine?.(LINE, line());
    t.injectTurn?.("Ask whether the caller needs anything else.");
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1));

    expect(JSON.stringify(llm.calls[0]?.prompt)).toContain(LINE);
    await vi.waitFor(() => expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(2));
    await t.stop();
  });

  test("a line cut while it plays reports INTERRUPTED", async () => {
    const { t, finishPlaying } = await holdingTransport();
    const controls = line();
    const done = t.speakLine?.(LINE, controls);
    await vi.waitFor(() => expect(controls.started()).toBe(true));
    expect(t.isReplying?.()).toBe(true);

    t.cancelReply();
    finishPlaying();

    await expect(done).resolves.toBe("interrupted");
    await t.stop();
  });

  test("a line queued behind another waits its turn, and an interrupt DROPS it", async () => {
    const { t, tts, finishPlaying } = await holdingTransport();
    const first = line();
    const second = line();
    const firstDone = t.speakLine?.("First line.", first);
    const secondDone = t.speakLine?.("Second line.", second);
    await vi.waitFor(() => expect(first.started()).toBe(true));
    // Queued, not talked over: the second has not reached TTS.
    expect(second.started()).toBe(false);
    expect(spoken(tts)).toBe("First line.");

    // An interrupt strands everything queued — the same rule a client cancel
    // follows for a queued model turn.
    t.cancelReply();
    finishPlaying();

    await expect(firstDone).resolves.toBe("interrupted");
    await expect(secondDone).resolves.toBe("dropped");
    expect(second.started()).toBe(false);
    expect(spoken(tts)).toBe("First line.");
    await t.stop();
  });

  test("a line taken back while queued is DROPPED and never reaches TTS", async () => {
    const { t, tts, finishPlaying } = await holdingTransport();
    const first = line();
    const second = line();
    const firstDone = t.speakLine?.("First line.", first);
    const secondDone = t.speakLine?.("Second line.", second);
    await vi.waitFor(() => expect(first.started()).toBe(true));

    second.takeBack();
    finishPlaying();

    await expect(firstDone).resolves.toBe("played");
    await expect(secondDone).resolves.toBe("dropped");
    expect(spoken(tts)).toBe("First line.");
    await t.stop();
  });

  test("a line asked for before TTS is open WAITS for it, behind the greeting", async () => {
    const { opts, tts } = makeOpts({
      sessionConfig: { systemPrompt: "s", greeting: "Hello there." },
    });
    const t = createPipelineTransport(opts);
    const done = t.speakLine?.(LINE, line());
    await t.start();

    await expect(done).resolves.toBe("played");
    expect(spoken(tts)).toBe(`Hello there.${LINE}`);
    await t.stop();
  });

  test("a line still waiting for TTS when the transport stops is DROPPED", async () => {
    const { opts, tts } = makeOpts();
    const t = createPipelineTransport(opts);
    const done = t.speakLine?.(LINE, line());
    await t.stop();

    await expect(done).resolves.toBe("dropped");
    expect(spoken(tts)).toBe("");
  });

  test("a line asked of a stopped transport is DROPPED", async () => {
    const { opts, tts } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    await t.stop();

    await expect(t.speakLine?.(LINE, line())).resolves.toBe("dropped");
    expect(spoken(tts)).toBe("");
  });

  test("isReplying is false while the agent is silent", async () => {
    const { opts } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    expect(t.isReplying?.()).toBe(false);
    await t.stop();
    expect(t.isReplying?.()).toBe(false);
  });
});
