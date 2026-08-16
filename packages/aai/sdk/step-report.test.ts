// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `report()`.
 *
 * Three claims, and each is a way a run could be harmed by its own narration:
 * a published reporter gets the line, an unpublished one still leaves a trace,
 * and neither path may ever reject.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { publishStepReporter, report } from "./step-report.ts";

afterEach(() => publishStepReporter(undefined));

describe("report", () => {
  test("hands the line to the published reporter and waits for it", async () => {
    const written: string[] = [];
    publishStepReporter(async (line) => {
      await Promise.resolve();
      written.push(line);
    });
    await report("Transcribing 0:00–0:58.");
    // Awaited rather than fired: a step that awaits `report()` must not race
    // the chunk it just wrote against the request reading it back. The push
    // happens AFTER the reporter's own await, so this one assertion carries
    // both claims — a `let settled` flag flipped in the same continuation said
    // nothing the line below does not.
    expect(written).toEqual(["Transcribing 0:00–0:58."]);
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
