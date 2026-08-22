// Copyright 2026 the AAI authors. MIT license.
// Specs for the per-turn LLM timing line. The value of this trace is that a
// stalled turn can be attributed at all, so what matters is that the marks
// distinguish the causes — not the exact numbers.

import { describe, expect, test, type vi } from "vitest";
import { makeLogger } from "../_test-utils.ts";
import { createTurnTrace } from "./pipeline-llm-trace.ts";

/** A logger that records `info` calls, plus a clock the test drives. */
function setup(adopted = false): {
  info: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof createTurnTrace>;
  advance(ms: number): void;
} {
  const log = makeLogger();
  let t = 1000;
  const trace = createTurnTrace({
    log,
    sid: "s1",
    adopted,
    now: () => t,
  });
  return {
    info: log.info,
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

  // The AI SDK enqueues `start` and `start-step` synchronously out of
  // `streamText`, before the request has a response, so timing them made
  // `firstPartMs` a measure of our own bookkeeping: every real turn logged 0-2
  // beside a `firstToolMs` of 600-1200. That reads as an instant model, which
  // is the opposite of what the mark exists to report — and it is invisible,
  // because a plausible number is present.
  test("SDK lifecycle parts do not stop the clock; the model's first part does", () => {
    const { info, trace, advance } = setup();
    trace.onPart("start");
    trace.onPart("start-step");
    advance(1100);
    trace.onPart("text-delta");
    trace.done({ steps: 1, aborted: false });
    expect(meta(info)).toMatchObject({ firstPartMs: 1100 });
  });

  // A turn whose only outcome is a provider error still reached the provider,
  // and how long that took is the number worth having.
  test("an error part stops the clock", () => {
    const { info, trace, advance } = setup();
    trace.onPart("start");
    advance(700);
    trace.onPart("error");
    trace.done({ steps: 0, aborted: false });
    expect(meta(info)).toMatchObject({ firstPartMs: 700 });
  });

  // A turn that only ever emitted lifecycle parts produced NOTHING, and must
  // report that the same way an empty turn does — not as an instant one.
  test("lifecycle parts alone leave the mark absent", () => {
    const { info, trace, advance } = setup();
    trace.onPart("start");
    trace.onPart("start-step");
    trace.onPart("finish-step");
    advance(4000);
    trace.done({ steps: 0, aborted: true });
    expect(meta(info)).not.toHaveProperty("firstPartMs");
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
