// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI TTS frame vocabulary as `handleMessage` reads it, one frame at
 * a time over a real session shell: audio decodes, both acknowledgements end
 * the synthesis, `Cancelled` ends the cancel window, and inside that window
 * only `Error` gets through.
 */

import { createNanoEvents } from "nanoevents";
import { describe, expect, test, vi } from "vitest";
import { createTtsSessionShell } from "../_utils.ts";
import type { TtsError, TtsEvents } from "../openers.ts";
import { pcmBase64 } from "./_fake-ws-test-utils.ts";
import { type CancelWindow, handleMessage, parseServerFrame } from "./assemblyai-frames.ts";
import { createAssemblyAITtsLifecycle } from "./assemblyai-lifecycle.ts";

function setup() {
  const emitter = createNanoEvents<TtsEvents>();
  const shell = createTtsSessionShell({ emitter, teardown: () => undefined });
  const audio: number[][] = [];
  const errors: TtsError[] = [];
  emitter.on("audio", (pcm) => audio.push([...pcm]));
  emitter.on("error", (err) => errors.push(err));
  const onComplete = vi.fn();
  const onWords = vi.fn();
  // The real window, over a socket that always carries the `Cancel`.
  const lifecycle = createAssemblyAITtsLifecycle({
    socketOpen: () => true,
    sendCancel: () => undefined,
    replaceSocket: () => Promise.resolve(),
    adoptSocket: () => undefined,
    dropQueue: () => undefined,
    reconnectFailed: () => undefined,
  });
  const cancels: CancelWindow = {
    abandoned: () => lifecycle.abandoned(),
    onCancelled: () => lifecycle.send({ type: "CANCELLED" }),
  };
  const shut = (): void => lifecycle.send({ type: "CANCEL" });
  const deliver = (frame: unknown): void =>
    handleMessage(JSON.stringify(frame), shell, onComplete, onWords, cancels);
  return { shell, audio, errors, onComplete, onWords, cancels, shut, deliver };
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

  test("FlushDone acknowledges the synthesis; an Audio frame never does", () => {
    // The documented Audio frame has no `is_final`: only FlushDone ends a flush.
    const { audio, deliver, onComplete } = setup();
    deliver({ type: "Audio", audio: pcmBase64([7]), is_final: true });
    expect(onComplete).not.toHaveBeenCalled();
    deliver({ type: "FlushDone" });
    expect(onComplete).toHaveBeenCalledTimes(1);
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
    const { audio, errors, deliver, onComplete, cancels, shut } = setup();
    shut();
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

describe("parseServerFrame", () => {
  const b64 = pcmBase64([1, -2, 3, 32_767, -32_768]);
  // Every frame here must read exactly as the generic parse reads it, lifted or not.
  const generic = (text: string): unknown => JSON.parse(text);
  const cases: Record<string, string> = {
    documented: `{"type":"Audio","audio":"${b64}"}`,
    "audio key first": `{"audio":"${b64}","type":"Audio"}`,
    "extra fields": `{"type":"Audio","audio":"${b64}","seq":3,"meta":{"a":"b"}}`,
    whitespace: `{ "type": "Audio", "audio": "${b64}" }`,
    "empty payload": `{"type":"Audio","audio":""}`,
    "non-ASCII elsewhere": `{"type":"Audio","note":"caf\\u00e9 ☕","audio":"${b64}"}`,
    "nested audio key only": `{"type":"Audio","meta":{"audio":"${b64}"}}`,
    "key spelled inside a string": `{"type":"a\\",\\"audio\\":\\"z","audio":"${b64}"}`,
    "string ending in a backslash": `{"type":"a\\\\","audio":"${b64}"}`,
    "escaped quote before key": `{"t\\"audio":"v","type":"Begin"}`,
    "escaped payload": `{"type":"Audio","audio":"${b64.slice(0, 4)}\\/${b64.slice(4)}"}`,
    "duplicate key": `{"type":"Audio","audio":"${b64}","audio":""}`,
    "not audio": `{"type":"FlushDone"}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    test(`${name}: a Buffer frame parses as JSON.parse would`, () => {
      expect(parseServerFrame(Buffer.from(text))).toEqual(generic(text));
      expect(parseServerFrame(text)).toEqual(generic(text));
    });
  }

  test("an unparseable frame is undefined on both paths", () => {
    expect(parseServerFrame(Buffer.from(`{"type":"Audio","audio":"${b64}"`))).toBeUndefined();
    expect(
      parseServerFrame(Buffer.from(`{"type":"Audio","audio":"${b64}"} trailing`)),
    ).toBeUndefined();
    expect(parseServerFrame("not json")).toBeUndefined();
  });

  test("a lifted Audio frame still decodes to the same PCM", () => {
    const { audio, shell, onComplete, onWords, cancels } = setup();
    handleMessage(Buffer.from(cases["audio key first"] ?? ""), shell, onComplete, onWords, cancels);
    expect(audio).toEqual([[1, -2, 3, 32_767, -32_768]]);
  });
});
