// Copyright 2026 the AAI authors. MIT license.

import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, test } from "vitest";
import { smoothTextStream } from "./pipeline-smooth.ts";

/** Run parts through the transform and collect the output. */
async function run(parts: TextStreamPart<ToolSet>[]): Promise<TextStreamPart<ToolSet>[]> {
  const transform = smoothTextStream<ToolSet>()({
    tools: {},
    stopStream: () => undefined,
  });
  const out: TextStreamPart<ToolSet>[] = [];
  const writer = transform.writable.getWriter();
  const reads = (async () => {
    for await (const part of transform.readable as unknown as AsyncIterable<
      TextStreamPart<ToolSet>
    >) {
      out.push(part);
    }
  })();
  for (const part of parts) await writer.write(part);
  await writer.close();
  await reads;
  return out;
}

function textDelta(text: string, id = "0"): TextStreamPart<ToolSet> {
  return { type: "text-delta", id, text };
}

describe("smoothTextStream", () => {
  test("coalesces text deltas into whole words", async () => {
    const out = await run([textDelta("He"), textDelta("llo "), textDelta("wor"), textDelta("ld")]);
    expect(out).toEqual([
      { type: "text-delta", id: "0", text: "Hello " },
      { type: "text-delta", id: "0", text: "world" },
    ]);
  });

  test("flushes buffered text before a non-text part", async () => {
    const out = await run([textDelta("Hi"), { type: "text-end", id: "0" }]);
    expect(out).toEqual([
      { type: "text-delta", id: "0", text: "Hi" },
      { type: "text-end", id: "0" },
    ]);
  });

  test("passes reasoning deltas through untouched, keeping the thinking signature", async () => {
    // Anthropic sends the thinking signature as an empty reasoning-delta whose
    // providerMetadata carries the signature. With `display: "omitted"` this is
    // the ONLY reasoning content — the SDK's smoothStream buffers it and drops
    // the metadata, which is exactly the bug this transform exists to avoid.
    const signatureDelta: TextStreamPart<ToolSet> = {
      type: "reasoning-delta",
      id: "1",
      text: "",
      providerMetadata: { anthropic: { signature: "sig-abc" } },
    };
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "reasoning-start", id: "1" },
      signatureDelta,
      { type: "reasoning-end", id: "1" },
    ];
    const out = await run(parts);
    expect(out).toEqual(parts);
  });

  test("does not reorder reasoning relative to surrounding text", async () => {
    const out = await run([
      textDelta("One mo"),
      { type: "reasoning-start", id: "1" },
      {
        type: "reasoning-delta",
        id: "1",
        text: "",
        providerMetadata: { anthropic: { signature: "sig" } },
      },
      { type: "reasoning-end", id: "1" },
      textDelta("ment"),
    ]);
    // "One " is emitted at the word boundary; "mo" flushes before reasoning.
    expect(out.map((p) => p.type)).toEqual([
      "text-delta",
      "text-delta",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-delta",
    ]);
    expect(out[0]).toMatchObject({ text: "One " });
    expect(out[1]).toMatchObject({ text: "mo" });
    expect(out[5]).toMatchObject({ text: "ment" });
  });

  test("keeps providerMetadata on the flushed text remainder", async () => {
    const out = await run([
      {
        type: "text-delta",
        id: "0",
        text: "tail",
        providerMetadata: { anthropic: { foo: "bar" } },
      },
      { type: "text-end", id: "0" },
    ]);
    expect(out[0]).toEqual({
      type: "text-delta",
      id: "0",
      text: "tail",
      providerMetadata: { anthropic: { foo: "bar" } },
    });
  });

  test("flushes per-id when the text part id changes", async () => {
    const out = await run([textDelta("a", "0"), textDelta("b", "1")]);
    expect(out).toEqual([
      { type: "text-delta", id: "0", text: "a" },
      { type: "text-delta", id: "1", text: "b" },
    ]);
  });

  test("flushes remaining text at end of stream", async () => {
    const out = await run([textDelta("dangling")]);
    expect(out).toEqual([{ type: "text-delta", id: "0", text: "dangling" }]);
  });
});
