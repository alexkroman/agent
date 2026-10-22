// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { assemblyAITtsUrl, generateFrames } from "./assemblyai-wire.ts";

const fail = (message: string) => new Error(message);

describe("assemblyAITtsUrl", () => {
  test("dials the documented US host and path with voice_id and sample_rate", () => {
    const url = new URL(assemblyAITtsUrl({ voice: "aai-jane", sampleRate: 24_000 }, fail));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("tts.us.assemblyai.com");
    expect(url.pathname).toBe("/v1/ws");
    expect(url.searchParams.get("voice_id")).toBe("aai-jane");
    expect(url.searchParams.get("sample_rate")).toBe("24000");
    // Retired: the service closes a session that sends it with 3006.
    expect(url.searchParams.has("voice")).toBe(false);
    expect(url.searchParams.has("language")).toBe(false);
  });

  test("passes the voice through untouched — slugs and UUIDs alike", () => {
    const uuid = "813d3219-cd78-545e-93dc-3a0c6fc2d614";
    const url = new URL(assemblyAITtsUrl({ voice: uuid, sampleRate: 16_000 }, fail));
    expect(url.searchParams.get("voice_id")).toBe(uuid);
  });

  test("maps the ISO code to the service's language name", () => {
    const url = new URL(
      assemblyAITtsUrl({ voice: "aai-jane", language: "es", sampleRate: 24_000 }, fail),
    );
    expect(url.searchParams.get("language")).toBe("spanish");
  });

  test("throws through `fail` on an unsupported language", () => {
    expect(() =>
      assemblyAITtsUrl({ voice: "aai-jane", language: "xx", sampleRate: 24_000 }, fail),
    ).toThrow(/unsupported language "xx"/);
  });

  test("a host override replaces the default — the EU host for residency", () => {
    const url = new URL(
      assemblyAITtsUrl(
        { voice: "aai-jane", sampleRate: 24_000, host: "tts.eu.assemblyai.com" },
        fail,
      ),
    );
    expect(url.host).toBe("tts.eu.assemblyai.com");
    expect(url.pathname).toBe("/v1/ws");
  });

  test("an empty host counts as unset rather than building wss:///v1/ws", () => {
    const url = new URL(
      assemblyAITtsUrl({ voice: "aai-jane", sampleRate: 24_000, host: "" }, fail),
    );
    expect(url.host).toBe("tts.us.assemblyai.com");
  });
});

describe("generateFrames", () => {
  test("empty text is no frames", () => {
    expect(generateFrames("")).toEqual([]);
  });

  test("text within the cap is one frame", () => {
    expect(generateFrames("Hello there.")).toEqual([{ type: "Generate", text: "Hello there." }]);
  });

  test("splits past 2000 characters into frames that rejoin to the input exactly", () => {
    const text = "abcdefghij".repeat(450); // 4500 chars
    const frames = generateFrames(text);
    expect(frames.map((f) => f.text.length)).toEqual([2000, 2000, 500]);
    // The service joins consecutive frames with no separator.
    expect(frames.map((f) => f.text).join("")).toBe(text);
    for (const frame of frames) expect(frame.type).toBe("Generate");
  });

  test("never splits a surrogate pair at a frame boundary", () => {
    // An emoji straddling index 2000: its high surrogate is char 1999.
    const text = `${"a".repeat(1999)}😀${"b".repeat(10)}`;
    const frames = generateFrames(text);
    expect(frames.map((f) => f.text.length)).toEqual([1999, 12]);
    expect(frames[1]?.text.startsWith("😀")).toBe(true);
    expect(frames.map((f) => f.text).join("")).toBe(text);
    for (const frame of frames) expect(frame.text.length).toBeLessThanOrEqual(2000);
  });
});
