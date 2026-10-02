// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI TTS frame vocabulary as `handleMessage` reads it, one frame at
 * a time over a real session shell: audio decodes, both acknowledgements end
 * the synthesis, `Cancelled` closes the barrier, and inside the barrier only
 * `Error` gets through.
 */

import { createNanoEvents } from "nanoevents";
import { describe, expect, test, vi } from "vitest";
import { createTtsSessionShell } from "../_utils.ts";
import type { TtsError, TtsEvents } from "../openers.ts";
import { pcmBase64 } from "./_fake-ws-test-utils.ts";
import { createCancelBarrier } from "./assemblyai-cancel.ts";
import { handleMessage } from "./assemblyai-frames.ts";

function setup() {
  const emitter = createNanoEvents<TtsEvents>();
  const shell = createTtsSessionShell({ emitter, teardown: () => undefined });
  const audio: number[][] = [];
  const errors: TtsError[] = [];
  emitter.on("audio", (pcm) => audio.push([...pcm]));
  emitter.on("error", (err) => errors.push(err));
  const onComplete = vi.fn();
  const onWords = vi.fn();
  const cancels = createCancelBarrier(() => undefined);
  const deliver = (frame: unknown): void =>
    handleMessage(JSON.stringify(frame), shell, onComplete, onWords, cancels);
  return { shell, audio, errors, onComplete, onWords, cancels, deliver };
}

describe("handleMessage", () => {
  test("an Audio frame decodes base64 PCM16; an empty one emits nothing", () => {
    const { audio, deliver, onComplete } = setup();
    deliver({ type: "Audio", audio: pcmBase64([1, -2, 3]) });
    deliver({ type: "Audio", audio: "" });
    deliver({ type: "Audio" });
    expect(audio).toEqual([[1, -2, 3]]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("FlushDone and an is_final Audio frame each acknowledge the synthesis", () => {
    const { audio, deliver, onComplete } = setup();
    deliver({ type: "FlushDone" });
    deliver({ type: "Audio", audio: pcmBase64([7]), is_final: true });
    expect(onComplete.mock.calls).toEqual([["flush_done"], ["is_final"]]);
    expect(audio).toEqual([[7]]);
  });

  test("WordBoundaries goes to the word handler and is NOT an acknowledgement", () => {
    const { deliver, onWords, onComplete } = setup();
    deliver({ type: "WordBoundaries", words: [] });
    expect(onWords).toHaveBeenCalledWith({ type: "WordBoundaries", words: [] });
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("an Error frame is a stream error naming the code and reason", () => {
    const { errors, deliver } = setup();
    deliver({ type: "Error", error_code: "invalid_voice", error: "no such voice" });
    deliver({ type: "Error", error: "   " });
    expect(errors.map((err) => [err.code, err.message])).toEqual([
      ["tts_stream_error", "AssemblyAI TTS (invalid_voice): no such voice"],
      ["tts_stream_error", "AssemblyAI TTS (): unknown"],
    ]);
  });

  test("unparseable, Begin and Warning frames are ignored", () => {
    const { audio, errors, shell, onComplete, onWords, cancels } = setup();
    handleMessage("{not json", shell, onComplete, onWords, cancels);
    handleMessage(
      Buffer.from(JSON.stringify({ type: "Begin" })),
      shell,
      onComplete,
      onWords,
      cancels,
    );
    handleMessage(
      JSON.stringify({ type: "Warning", warning: "x" }),
      shell,
      onComplete,
      onWords,
      cancels,
    );
    expect([audio, errors, onComplete.mock.calls, onWords.mock.calls]).toEqual([[], [], [], []]);
  });

  test("inside the cancel window only Error passes; Cancelled reopens it", () => {
    const { audio, errors, deliver, onComplete, cancels } = setup();
    cancels.arm();
    deliver({ type: "Audio", audio: pcmBase64([1]) });
    deliver({ type: "FlushDone" });
    deliver({ type: "Error", error_code: 1, error: "socket" });
    expect(audio).toEqual([]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);

    deliver({ type: "Cancelled" });
    expect(cancels.abandoned()).toBe(false);
    deliver({ type: "Audio", audio: pcmBase64([2]) });
    expect(audio).toEqual([[2]]);
  });
});
