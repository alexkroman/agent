// Copyright 2026 the AAI authors. MIT license.
// Specs for the per-turn LLM timing line. The value of this trace is that a
// stalled turn can be attributed at all, so what matters is that the marks
// distinguish the causes — not the exact numbers.
//
// The marks now come from the AI SDK's telemetry integration rather than from
// counting stream parts, so these drive `trace.telemetry.onLanguageModelCallEnd`
// with the event shape `streamText` passes it. That is the contract worth
// pinning: a hand-rolled part allow-list is exactly what this replaced, after
// it spent two benchmark runs reporting `firstPartMs: 0`.

import type { LanguageModelCallEndEvent } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createTurnTrace } from "./pipeline-llm-trace.ts";

/** A logger that records `info` calls, plus a clock the test drives. */
function setup(): {
  info: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof createTurnTrace>;
  advance(ms: number): void;
} {
  const info = vi.fn();
  let t = 1000;
  const trace = createTurnTrace({
    log: { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sid: "s1",
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

/**
 * One `onLanguageModelCallEnd` event, narrowed to the fields the trace reads.
 * Cast because the real event carries the whole model call — prompt, provider
 * metadata, response id — none of which this module looks at, and restating it
 * would pin the SDK's shape rather than our use of it.
 */
function callEnd(opts: {
  timeToFirstOutputMs?: number | undefined;
  toolCall?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}): LanguageModelCallEndEvent {
  return {
    performance: { timeToFirstOutputMs: opts.timeToFirstOutputMs },
    usage: { inputTokens: opts.inputTokens ?? 0, outputTokens: opts.outputTokens ?? 0 },
    content: opts.toolCall ? [{ type: "tool-call" }] : [{ type: "text", text: "hi" }],
  } as unknown as LanguageModelCallEndEvent;
}

const meta = (info: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  info.mock.calls[0]?.[1] as Record<string, unknown>;

const end = (trace: ReturnType<typeof createTurnTrace>, event: LanguageModelCallEndEvent): void => {
  void trace.telemetry.onLanguageModelCallEnd?.(event);
};

describe("createTurnTrace", () => {
  test("reports the SDK's time-to-first-output and the wall clock to the first tool call", () => {
    const { info, trace, advance } = setup();
    advance(900);
    end(trace, callEnd({ timeToFirstOutputMs: 640 }));
    advance(600);
    end(trace, callEnd({ toolCall: true }));
    advance(500);
    trace.done({ adopted: false, aborted: false });

    expect(meta(info)).toMatchObject({
      sid: "s1",
      adopted: false,
      // Measured inside the provider call, not from the turn's start — that is
      // the whole reason it comes from the SDK.
      firstOutputMs: 640,
      firstToolMs: 1500,
      totalMs: 2000,
      steps: 2,
    });
  });

  test("counts one step per model call, which is what a step IS", () => {
    const { info, trace } = setup();
    end(trace, callEnd({ toolCall: true }));
    end(trace, callEnd({ toolCall: true }));
    end(trace, callEnd({}));
    trace.done({ adopted: false, aborted: false });
    expect(meta(info)).toMatchObject({ steps: 3 });
  });

  test("takes time-to-first-output from the FIRST call only", () => {
    // Later calls are separated by tool execution; "how long until the model
    // started producing" is a question about the first request.
    const { info, trace } = setup();
    end(trace, callEnd({ timeToFirstOutputMs: 300, toolCall: true }));
    end(trace, callEnd({ timeToFirstOutputMs: 4000 }));
    trace.done({ adopted: false, aborted: false });
    expect(meta(info)).toMatchObject({ firstOutputMs: 300 });
  });

  test("omits a mark that never happened rather than logging a zero", () => {
    // A turn that produced nothing is a different animal from one that
    // produced its first token instantly, and a zero averages in as the fast
    // case. The SDK reports `timeToFirstOutputMs: undefined` for a
    // non-streaming call, which must not become 0 either.
    const { info, trace, advance } = setup();
    advance(120);
    end(trace, callEnd({ timeToFirstOutputMs: undefined }));
    trace.done({ adopted: false, aborted: true });

    const logged = meta(info);
    expect(logged).not.toHaveProperty("firstOutputMs");
    expect(logged).not.toHaveProperty("firstToolMs");
    expect(logged).toMatchObject({ totalMs: 120, aborted: true });
  });

  test("a turn that never reached the provider still logs, with no marks", () => {
    const { info, trace, advance } = setup();
    advance(40);
    trace.done({ adopted: false, aborted: true });
    expect(meta(info)).toMatchObject({ totalMs: 40, steps: 0, aborted: true });
  });

  test("sums token usage across the turn's calls", () => {
    // The hand-rolled version could not see this at all; it is what makes a
    // turn's COST readable beside its latency.
    const { info, trace } = setup();
    end(trace, callEnd({ inputTokens: 900, outputTokens: 20, toolCall: true }));
    end(trace, callEnd({ inputTokens: 1100, outputTokens: 45 }));
    trace.done({ adopted: false, aborted: false });
    expect(meta(info)).toMatchObject({ inputTokens: 2000, outputTokens: 65 });
  });

  test("omits token counts entirely when the provider reported none", () => {
    const { info, trace } = setup();
    end(trace, callEnd({}));
    trace.done({ adopted: false, aborted: false });
    expect(meta(info)).not.toHaveProperty("inputTokens");
  });

  test("`adopted` is decided at done(), because that is when it is known", () => {
    // The trace belongs to the REQUEST — a speculation starts one and hands it
    // over — so whether the turn adopted it is only settled at the end.
    const { info, trace } = setup();
    end(trace, callEnd({ timeToFirstOutputMs: 10 }));
    trace.done({ adopted: true, aborted: false });
    expect(meta(info)).toMatchObject({ adopted: true });
  });

  test("done is idempotent", () => {
    const { info, trace } = setup();
    trace.done({ adopted: false, aborted: false });
    trace.done({ adopted: false, aborted: false });
    expect(info).toHaveBeenCalledTimes(1);
  });
});
