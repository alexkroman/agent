// Copyright 2026 the AAI authors. MIT license.
/**
 * The STT/TTS halves of `fallback([...])`, over fake openers: when a member is
 * abandoned, when it is NOT, what each switch reports, and which key each
 * member opens with.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import type { ProviderFailover } from "./_failover.ts";
import { createFallbackSttOpener, createFallbackTtsOpener } from "./fallback.ts";
import type { SttError, TtsError } from "./openers.ts";

const sttOptions = (signal = new AbortController().signal) => ({
  sampleRate: 16_000,
  apiKey: "passed-key",
  signal,
});
const ttsOptions = sttOptions;

describe("fallback STT", () => {
  test("opens the next member when the primary's open() rejects, and reports the switch", async () => {
    const secondary = createFakeSttProvider();
    const opener = createFallbackSttOpener(
      [
        {
          opener: createFailingSttProvider("stt_auth_failed", "401 bad key"),
          envVar: "A",
          kind: "a",
        },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      { A: "key-a", B: "key-b" },
    );
    const failovers: ProviderFailover[] = [];
    const session = await opener.openReporting(sttOptions(), (f) => failovers.push(f));

    expect(failovers).toEqual([{ stage: "stt", from: "a", to: "b", reason: "401 bad key" }]);
    // Each member reads its OWN key out of the env, never the one passed in.
    expect(secondary.last()?.options.apiKey).toBe("key-b");

    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));
    secondary.last()?.fireFinal("hello");
    expect(finals).toEqual(["hello"]);
  });

  test("without an env, every member is handed the key passed to open()", async () => {
    const secondary = createFakeSttProvider();
    const opener = createFallbackSttOpener(
      [
        { opener: createFailingSttProvider("stt_connect_failed", "down"), envVar: "A", kind: "a" },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      undefined,
    );
    await opener.open(sttOptions());
    expect(secondary.last()?.options.apiKey).toBe("passed-key");
  });

  test("an error BEFORE the first transcript swaps members behind the same session", async () => {
    const primary = createFakeSttProvider();
    const secondary = createFakeSttProvider();
    const opener = createFallbackSttOpener(
      [
        { opener: primary, envVar: "A", kind: "a" },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      { A: "ka", B: "kb" },
    );
    const failovers: ProviderFailover[] = [];
    const session = await opener.openReporting(sttOptions(), (f) => failovers.push(f));
    const errors: SttError[] = [];
    const partials: string[] = [];
    session.on("error", (e) => errors.push(e));
    session.on("partial", (t) => partials.push(t));

    primary.last()?.fireError("stt_stream_error", "session cap");
    await vi.waitFor(() => expect(secondary.sessions).toHaveLength(1));

    expect(errors).toEqual([]);
    expect(primary.last()?.closed.value).toBe(true);
    expect(failovers.map((f) => [f.from, f.to])).toEqual([["a", "b"]]);
    session.sendAudio(new Int16Array(4));
    expect(secondary.last()?.audioFrames).toHaveLength(1);
    secondary.last()?.firePartial("hi");
    expect(partials).toEqual(["hi"]);
  });

  test("an error AFTER output is forwarded — no failover mid-conversation", async () => {
    const primary = createFakeSttProvider();
    const secondary = createFakeSttProvider();
    const opener = createFallbackSttOpener(
      [
        { opener: primary, envVar: "A", kind: "a" },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      {},
    );
    const failovers: ProviderFailover[] = [];
    const session = await opener.openReporting(sttOptions(), (f) => failovers.push(f));
    const errors: SttError[] = [];
    session.on("error", (e) => errors.push(e));

    primary.last()?.firePartial("hel");
    primary.last()?.fireError("stt_stream_error", "dropped");
    expect(errors.map((e) => e.message)).toEqual(["dropped"]);
    expect(failovers).toEqual([]);
    expect(secondary.sessions).toHaveLength(0);
  });

  test("when every member fails to open, the LAST error is the stage's", async () => {
    const opener = createFallbackSttOpener(
      [
        { opener: createFailingSttProvider("stt_connect_failed", "first"), envVar: "A", kind: "a" },
        { opener: createFailingSttProvider("stt_auth_failed", "second"), envVar: "B", kind: "b" },
      ],
      {},
    );
    const failovers: ProviderFailover[] = [];
    await expect(opener.openReporting(sttOptions(), (f) => failovers.push(f))).rejects.toThrow(
      "second",
    );
    // One switch was made; there was nothing to switch to after the last.
    expect(failovers).toHaveLength(1);
  });

  test("never fails over on an abort", async () => {
    const controller = new AbortController();
    const secondary = createFakeSttProvider();
    const opener = createFallbackSttOpener(
      [
        {
          opener: {
            name: "aborting",
            open: async () => {
              controller.abort();
              throw new Error("aborted");
            },
          },
          envVar: "A",
          kind: "a",
        },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      {},
    );
    await expect(opener.open(sttOptions(controller.signal))).rejects.toThrow("aborted");
    expect(secondary.sessions).toHaveLength(0);
  });

  test("claims the optional controls only when the adopted member has them", async () => {
    const plain = createFallbackSttOpener(
      [
        {
          opener: {
            name: "bare",
            open: async () => ({
              sendAudio: () => undefined,
              on: () => () => true,
              close: async () => undefined,
            }),
          },
          envVar: "",
          kind: "bare",
        },
        { opener: createFakeSttProvider(), envVar: "", kind: "b" },
      ],
      {},
    );
    const session = await plain.open(sttOptions());
    expect(session.forceEndOfTurn).toBeUndefined();
    expect(session.updateEndpointing).toBeUndefined();

    const fake = createFakeSttProvider();
    const rich = createFallbackSttOpener(
      [
        { opener: fake, envVar: "", kind: "a" },
        { opener: createFakeSttProvider(), envVar: "", kind: "b" },
      ],
      {},
    );
    const richSession = await rich.open(sttOptions());
    richSession.forceEndOfTurn?.();
    expect(fake.last()?.forceEndOfTurn).toHaveBeenCalledOnce();
  });
});

describe("fallback TTS", () => {
  test("replays the text a member that failed before speaking never got to say", async () => {
    const primary = createFakeTtsProvider({ autoDoneOnFlush: false });
    const secondary = createFakeTtsProvider({ autoDoneOnFlush: false });
    const opener = createFallbackTtsOpener(
      [
        { opener: primary, envVar: "A", kind: "a" },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      {},
    );
    const failovers: ProviderFailover[] = [];
    const session = await opener.openReporting(ttsOptions(), (f) => failovers.push(f));
    const audio: Int16Array[] = [];
    session.on("audio", (pcm) => audio.push(pcm));

    session.sendText("Hi, how can ");
    session.sendText("I help?");
    session.flush();
    primary.last()?.fireError("tts_auth_failed", "403");
    await vi.waitFor(() => expect(secondary.sessions).toHaveLength(1));

    expect(failovers).toEqual([{ stage: "tts", from: "a", to: "b", reason: "403" }]);
    expect(secondary.last()?.textChunks).toEqual(["Hi, how can ", "I help?"]);
    expect(secondary.last()?.flush).toHaveBeenCalledOnce();
    secondary.last()?.fireAudio(new Int16Array(2));
    expect(audio).toHaveLength(1);
  });

  test("an error once audio has played is the turn's, and nothing is replayed", async () => {
    const primary = createFakeTtsProvider();
    const secondary = createFakeTtsProvider();
    const opener = createFallbackTtsOpener(
      [
        { opener: primary, envVar: "A", kind: "a" },
        { opener: secondary, envVar: "B", kind: "b" },
      ],
      {},
    );
    const session = await opener.open(ttsOptions());
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    session.sendText("Hello.");
    primary.last()?.fireAudio(new Int16Array(2));
    primary.last()?.fireError("tts_stream_error", "socket closed");
    expect(errors.map((e) => e.message)).toEqual(["socket closed"]);
    expect(secondary.sessions).toHaveLength(0);
  });

  test("open() failure walks the list; the last member's error rejects", async () => {
    const opener = createFallbackTtsOpener(
      [
        { opener: createFailingTtsProvider("tts_connect_failed", "one"), envVar: "A", kind: "a" },
        { opener: createFailingTtsProvider("tts_connect_failed", "two"), envVar: "B", kind: "b" },
        { opener: createFailingTtsProvider("tts_connect_failed", "three"), envVar: "C", kind: "c" },
      ],
      {},
    );
    const failovers: ProviderFailover[] = [];
    await expect(opener.openReporting(ttsOptions(), (f) => failovers.push(f))).rejects.toThrow(
      "three",
    );
    expect(failovers.map((f) => `${f.from}->${f.to}`)).toEqual(["a->b", "b->c"]);
  });
});
