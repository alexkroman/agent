// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pure stream helpers in pipeline-stream.ts. Turn-level
// behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { describe, expect, test } from "vitest";
import { TTS_COALESCE_MAX_CHARS } from "../../sdk/constants.ts";
import { createTtsTextCoalescer } from "./pipeline-stream.ts";

describe("createTtsTextCoalescer", () => {
  function collect(): { sent: string[]; send: (text: string) => void } {
    const sent: string[] = [];
    return { sent, send: (text) => sent.push(text) };
  }

  test("forwards the first chunk immediately (time-to-first-byte)", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("Hello ");
    expect(sent).toEqual(["Hello "]);
  });

  test("batches subsequent words to a clause/punctuation boundary", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    for (const word of ["Sure, ", "I ", "can ", "help, ", "what's ", "up? ", "Ask ", "away."]) {
      c.send(word);
    }
    // First word immediate; then batches flush at each trailing punctuation mark.
    expect(sent).toEqual(["Sure, ", "I can help, ", "what's up? ", "Ask away."]);
    expect(sent.join("")).toBe("Sure, I can help, what's up? Ask away.");
  });

  test("flushes once the pending batch reaches TTS_COALESCE_MAX_CHARS without punctuation", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("first ");
    const word = "aaaa "; // 5 chars, no punctuation
    const wordsToCap = Math.ceil(TTS_COALESCE_MAX_CHARS / word.length);
    for (let i = 0; i < wordsToCap; i++) c.send(word);
    expect(sent.length).toBe(2); // first chunk + one size-capped batch
    expect(sent[1]?.length).toBeGreaterThanOrEqual(TTS_COALESCE_MAX_CHARS);
  });

  test("flush() sends any trailing fragment and is a no-op when empty", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("One ");
    c.send("more ");
    c.send("thing");
    c.flush();
    expect(sent.join("")).toBe("One more thing");
    const count = sent.length;
    c.flush();
    expect(sent.length).toBe(count);
  });

  test("empty deltas are ignored and do not consume the immediate first send", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("");
    c.send("Hi ");
    expect(sent).toEqual(["Hi "]);
  });
});
