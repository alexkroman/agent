// Copyright 2026 the AAI authors. MIT license.
/**
 * `benchPageHtml` — the browser page that cross-checks the playback bench in a
 * real `AudioContext`.
 *
 * Running it needs Chromium; what a unit spec CAN hold is the page's contract
 * with whoever drives it: the real worklet source is what it loads (not a
 * copy), the profiles and the PCM URL reach the script intact, the driver API
 * is installed under {@link BENCH_API}, and the one caller-supplied string
 * that lands in markup is escaped.
 */

import { describe, expect, test } from "vitest";
import { BENCH_API, benchPageHtml } from "./_playback-bench-page.ts";
import { playbackProcessorSource } from "./playback-processor.ts";

const PROFILES = {
  typical: [
    { atMs: 0, offset: 0, length: 960 },
    { atMs: 20, offset: 960, length: 960 },
  ],
};

function page(over: Partial<Parameters<typeof benchPageHtml>[0]> = {}): string {
  return benchPageHtml({
    pcmUrl: "/tts-reply-24k.pcm",
    sampleRate: 24_000,
    title: "one reply",
    profiles: PROFILES,
    ...over,
  });
}

describe("benchPageHtml", () => {
  test("is a whole document that loads the REAL playback worklet", () => {
    const html = page();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain(JSON.stringify(playbackProcessorSource));
    expect(html).toContain("registerProcessor('tap-processor'");
  });

  test("carries the PCM URL, the rate and every delivery schedule to the script", () => {
    const html = page();
    expect(html).toContain('fetch("/tts-reply-24k.pcm")');
    expect(html).toContain("const SAMPLE_RATE = 24000;");
    expect(html).toContain(`const PROFILES = ${JSON.stringify(PROFILES)};`);
  });

  test("installs the driver API on window under its published name", () => {
    expect(page()).toContain(`window[${JSON.stringify(BENCH_API)}] = {`);
  });

  test("starts the fill slider at the caller's default, else 200 ms", () => {
    expect(page()).toContain('step="25" value="200"');
    expect(page({ defaults: { fillMs: 400 } })).toContain('step="25" value="400"');
  });

  test("escapes the title wherever it lands in markup", () => {
    const html = page({ title: '<script>alert("x")</script> & co' });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; &#38; co");
  });
});
