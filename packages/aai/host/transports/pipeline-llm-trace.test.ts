// Copyright 2026 the AAI authors. MIT license.
// Specs for the per-turn LLM timing line. The value of this trace is that a
// stalled turn can be attributed at all, so what matters is that the marks
// distinguish the causes — not the exact numbers.

import { describe, expect, test, vi } from "vitest";
import { createTurnTrace } from "./pipeline-llm-trace.ts";

/** A logger that records `info` calls, plus a clock the test drives. */
function setup(adopted = false): {
  info: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof createTurnTrace>;
  advance(ms: number): void;
} {
  const info = vi.fn();
  let t = 1000;
  const trace = createTurnTrace({
    log: { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sid: "s1",
    adopted,
    now: () => t,
  });
  return {
    info,
    trace,
    advance(ms) {
      t += ms;
    },
  };
}

const meta = (info: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  info.mock.calls[0]?.[1] as Record<string, unknown>;

describe("createTurnTrace", () => {
  test("times the first part and the first tool call separately", () => {
    const { info, trace, advance } = setup();
    advance(900);
    trace.onPart("text-delta");
    advance(600);
    trace.onPart("tool-call");
    advance(500);
    trace.done({ steps: 2, aborted: false });

    expect(meta(info)).toMatchObject({
      sid: "s1",
      adopted: false,
      firstPartMs: 900,
      firstToolMs: 1500,
      totalMs: 2000,
      steps: 2,
    });
  });

  test("keeps the FIRST of each mark, not the last", () => {
    const { info, trace, advance } = setup();
    advance(100);
    trace.onPart("text-delta");
    advance(100);
    trace.onPart("text-delta");
    advance(100);
    trace.onPart("tool-call");
    advance(100);
    trace.onPart("tool-call");
    trace.done({ steps: 1, aborted: false });
    expect(meta(info)).toMatchObject({ firstPartMs: 100, firstToolMs: 300 });
  });

  test("a turn that produced nothing OMITS the marks rather than reporting zero", () => {
    // The distinction this preserves: a turn that died before the model
    // emitted anything is a different animal from one that answered
    // instantly, and a 0 would average in as the fast case — which is exactly
    // the confusion this trace exists to remove.
    const { info, trace, advance } = setup();
    advance(8000);
    trace.done({ steps: 0, aborted: true });
    const m = meta(info);
    expect(m).toMatchObject({ totalMs: 8000, steps: 0, aborted: true });
    expect(m).not.toHaveProperty("firstPartMs");
    expect(m).not.toHaveProperty("firstToolMs");
  });

  test("a text-only turn reports no tool mark", () => {
    const { info, trace, advance } = setup();
    advance(300);
    trace.onPart("text-delta");
    trace.done({ steps: 0, aborted: false });
    expect(meta(info)).toMatchObject({ firstPartMs: 300 });
    expect(meta(info)).not.toHaveProperty("firstToolMs");
  });

  test("adoption is recorded, since an adopted turn's TTFP means something else", () => {
    const { info, trace } = setup(true);
    trace.done({ steps: 0, aborted: false });
    expect(meta(info)).toMatchObject({ adopted: true });
  });

  test("done() is idempotent — one line per turn however often it unwinds", () => {
    const { info, trace } = setup();
    trace.done({ steps: 1, aborted: false });
    trace.done({ steps: 9, aborted: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(meta(info)).toMatchObject({ steps: 1 });
  });
});
