// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pure TTS-side helpers in pipeline-stream.ts. The
// `streamText` specs moved to pipeline-llm-stream.test.ts with the code; the
// turn-level behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { describe, expect, test, vi } from "vitest";
import { PIPELINE_FLUSH_TIMEOUT_MS, TTS_COALESCE_MAX_CHARS } from "../../sdk/constants.ts";
import { silentLogger } from "../_test-utils.ts";
import { createTtsTextCoalescer, flushTtsAndWait } from "./pipeline-stream.ts";

describe("createTtsTextCoalescer", () => {
  function collect(): {
    sent: string[];
    records: boolean[];
    send: (text: string, opts: { record: boolean }) => void;
  } {
    const sent: string[] = [];
    const records: boolean[] = [];
    return {
      sent,
      records,
      send: (text, opts) => {
        sent.push(text);
        records.push(opts.record);
      },
    };
  }

  test("forwards the first chunk immediately (time-to-first-byte)", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("Hello ", true);
    expect(sent).toEqual(["Hello "]);
  });

  test("boundary() releases a sub-threshold fragment instead of stranding it", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    // A turn that opens with speech, then calls a tool: "let me" is short and
    // unpunctuated, so batching would hold it for the whole tool-execution
    // window — the caller hears "Sure," then dead air.
    c.send("Sure, ", true);
    c.send("let me", true);
    expect(sent).toEqual(["Sure, "]);
    c.boundary();
    expect(sent).toEqual(["Sure, ", "let me"]);
  });

  test("boundary() re-arms the immediate first chunk for the post-tool reply", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("Checking. ", true);
    c.boundary();
    // Time-to-first-audio matters again after the tool gap, so the next
    // segment's opening words must not wait on a clause boundary.
    c.send("I ", true);
    expect(sent).toEqual(["Checking. ", "I "]);
    // ...and batching resumes from there.
    c.send("found ", true);
    c.send("three ", true);
    expect(sent).toEqual(["Checking. ", "I "]);
    c.flush();
    expect(sent).toEqual(["Checking. ", "I ", "found three "]);
  });

  test("boundary() on an empty buffer emits nothing", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.boundary();
    expect(sent).toEqual([]);
  });

  test("batches subsequent words to a clause/punctuation boundary", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    for (const word of ["Sure, ", "I ", "can ", "help, ", "what's ", "up? ", "Ask ", "away."]) {
      c.send(word, true);
    }
    // First word immediate; then batches flush at each trailing punctuation mark.
    expect(sent).toEqual(["Sure, ", "I can help, ", "what's up? ", "Ask away."]);
    expect(sent.join("")).toBe("Sure, I can help, what's up? Ask away.");
  });

  test("flushes once the pending batch reaches TTS_COALESCE_MAX_CHARS without punctuation", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("first ", true);
    const word = "aaaa "; // 5 chars, no punctuation
    const wordsToCap = Math.ceil(TTS_COALESCE_MAX_CHARS / word.length);
    for (let i = 0; i < wordsToCap; i++) c.send(word, true);
    expect(sent.length).toBe(2); // first chunk + one size-capped batch
    expect(sent[1]?.length).toBeGreaterThanOrEqual(TTS_COALESCE_MAX_CHARS);
  });

  test("flush() sends any trailing fragment and is a no-op when empty", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("One ", true);
    c.send("more ", true);
    c.send("thing", true);
    c.flush();
    expect(sent.join("")).toBe("One more thing");
    const count = sent.length;
    c.flush();
    expect(sent.length).toBe(count);
  });

  test("empty deltas are ignored and do not consume the immediate first send", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("", true);
    c.send("Hi ", true);
    expect(sent).toEqual(["Hi "]);
  });

  test("flushes before `record` flips, so no send mixes model text with filler", () => {
    const { sent, records } = collect();
    const c = createTtsTextCoalescer((text, opts) => {
      sent.push(text);
      records.push(opts.record);
    });
    c.send("Let me ", true);
    // Sub-threshold model text is buffered...
    c.send("check ", true);
    expect(sent).toEqual(["Let me "]);
    // ...and released by the filler rather than batched together with it: the
    // heard cursor slices history out of the recordable spans, so a mixed send
    // would put filler in the record (or drop model text from it).
    c.send("One moment.", false);
    expect(sent).toEqual(["Let me ", "check ", "One moment."]);
    expect(records).toEqual([true, true, false]);
  });
});
describe("flushTtsAndWait", () => {
  /** A TTS session whose `done` fires (or never fires) on demand. */
  function fakeTts(opts: { emitDone: boolean }) {
    const calls: string[] = [];
    let doneFn: (() => void) | undefined;
    const tts = {
      sendText: () => undefined,
      flush: () => {
        calls.push("flush");
        if (opts.emitDone) doneFn?.();
      },
      cancel: () => calls.push("cancel"),
      on: (event: string, fn: () => void) => {
        if (event === "done") doneFn = fn;
        return () => undefined;
      },
      close: async () => undefined,
    };
    return { tts, calls };
  }

  test("resolves quietly when the provider acknowledges the drain", async () => {
    const { tts, calls } = fakeTts({ emitDone: true });
    const emitError = vi.fn();

    await flushTtsAndWait({
      tts: tts as never,
      signal: new AbortController().signal,
      log: silentLogger,
      sid: "s1",
      emitError,
    });

    expect(calls).toEqual(["flush"]);
    expect(emitError).not.toHaveBeenCalled();
  });

  // Measured under concurrent load: the provider stops mid-utterance and the
  // turn only ends when this timeout fires. The caller hears a clipped reply
  // then silence, and NOTHING said so — the session went on reporting itself
  // healthy. It also leaves the provider's turn accounting mid-turn, which
  // `onTurnText` will not reset, so later turns inherit the desync.
  test("reports a drain timeout to the client and resynchronizes the session", async () => {
    vi.useFakeTimers();
    try {
      const { tts, calls } = fakeTts({ emitDone: false });
      const emitError = vi.fn();

      const pending = flushTtsAndWait({
        tts: tts as never,
        signal: new AbortController().signal,
        log: silentLogger,
        sid: "s1",
        emitError,
      });
      await vi.advanceTimersByTimeAsync(PIPELINE_FLUSH_TIMEOUT_MS + 10);
      await pending;

      // NON-fatal, and that is the whole point of the pairing below: the reply is
      // clipped and the session is RESYNCHRONIZED to keep going, so reporting it
      // as fatal (onError's default) had aai-ui release the microphone and end a
      // call that was still live.
      expect(emitError).toHaveBeenCalledWith("tts", expect.stringMatching(/cut short/i), {
        fatal: false,
      });
      expect(calls).toEqual(["flush", "cancel"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Barge-in aborts the drain. That is a normal interruption, not a provider
  // fault: reporting it would fire an error on every interrupted reply, and
  // cancelling is already the interrupt path's own job.
  test("stays silent when the drain is aborted by barge-in", async () => {
    vi.useFakeTimers();
    try {
      const { tts, calls } = fakeTts({ emitDone: false });
      const emitError = vi.fn();
      const controller = new AbortController();

      const pending = flushTtsAndWait({
        tts: tts as never,
        signal: controller.signal,
        log: silentLogger,
        sid: "s1",
        emitError,
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(PIPELINE_FLUSH_TIMEOUT_MS + 10);
      await pending;

      expect(emitError).not.toHaveBeenCalled();
      expect(calls).toEqual(["flush"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
