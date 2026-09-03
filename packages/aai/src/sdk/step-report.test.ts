// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `report()`.
 *
 * Three claims, and each is a way a run could be harmed by its own narration:
 * a published reporter gets the line, an unpublished one still leaves a trace,
 * and neither path may ever reject.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { emit, publishStepReporter, report } from "./step-report.ts";

/** One call the published reporter received, as a spec asks about it. */
type Written = { chunk: unknown; namespace: string | undefined; log: boolean | undefined };

/** Install a recording reporter and hand back what it was given. */
function recordingReporter(): Written[] {
  const written: Written[] = [];
  publishStepReporter(async (chunk, options) => {
    await Promise.resolve();
    written.push({ chunk, namespace: options?.namespace, log: options?.log });
  });
  return written;
}

afterEach(() => publishStepReporter(undefined));

describe("report", () => {
  test("hands the line to the published reporter and waits for it", async () => {
    const written = recordingReporter();
    await report("Transcribing 0:00–0:58.");
    // Awaited rather than fired: a step that awaits `report()` must not race
    // the chunk it just wrote against the request reading it back. The push
    // happens AFTER the reporter's own await, so this one assertion carries
    // both claims — a `let settled` flag flipped in the same continuation said
    // nothing the line below does not.
    expect(written).toEqual([
      { chunk: "Transcribing 0:00–0:58.", namespace: undefined, log: true },
    ]);
  });

  test("SWALLOWS a reporter that throws — a run never fails on its narration", async () => {
    publishStepReporter(() => {
      throw new Error("stream is gone");
    });
    await expect(report("still working")).resolves.toBeUndefined();
  });

  test("swallows a reporter that rejects", async () => {
    publishStepReporter(() => Promise.reject(new Error("closed")));
    await expect(report("still working")).resolves.toBeUndefined();
  });

  test("falls back to the console when nothing has published", async () => {
    // The case a spec calling an exported step is in: silence would make a step
    // under test look like it did nothing.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await report("Planning angles.");
    expect(spy).toHaveBeenCalledWith("[workflow] Planning angles.");
  });

  test("publishing REPLACES, and undefined unpublishes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    publishStepReporter(first);
    publishStepReporter(second);
    await report("one");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    publishStepReporter(undefined);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await report("two");
    expect(second).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
  });
});

describe("emit", () => {
  test("writes the chunk into the NAMED stream, and asks not to be logged", async () => {
    const written = recordingReporter();
    await emit("transcript", { index: 3, text: "and then we shipped it" });
    // The namespace is what keeps this out of `report()`'s stream, where an
    // object renders as `[object Object]` in the middle of the progress log; the
    // `log: false` is what keeps a chunk per segment out of the server log.
    expect(written).toEqual([
      {
        chunk: { index: 3, text: "and then we shipped it" },
        namespace: "transcript",
        log: false,
      },
    ]);
  });

  test("is AWAITED, so a step does not race the chunk it just wrote", async () => {
    // The same claim `report` makes and for the same reason: the recording push
    // happens after the reporter's own await, so arriving here at all is the
    // assertion.
    const written = recordingReporter();
    await emit("transcript", "done");
    expect(written).toHaveLength(1);
  });

  test("SWALLOWS a reporter that throws — a run never fails on a partial result", async () => {
    publishStepReporter(() => {
      throw new Error("stream is gone");
    });
    await expect(emit("transcript", { index: 1 })).resolves.toBeUndefined();
  });

  test("falls back to the console, naming the stream and summarizing the chunk", async () => {
    // A spec calling an exported step. Summarized rather than dumped: a chunk
    // here can be a whole segment of transcript.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await emit("transcript", { index: 2, text: "hello" });
    expect(spy).toHaveBeenCalledWith('[workflow] transcript: {"index":2,"text":"hello"}');
  });

  test("describes a chunk it cannot serialize rather than throwing", async () => {
    // Narration may not fail a run, and a cyclic chunk would not have survived
    // the stream either — so saying so beats throwing from this helper.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(emit("transcript", cyclic)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[workflow] transcript: [object Object]");
  });
});
