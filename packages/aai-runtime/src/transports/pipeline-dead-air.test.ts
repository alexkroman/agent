// Copyright 2026 the AAI authors. MIT license.
/**
 * What the dead-air cover DID, as something a log can answer.
 *
 * The firing has been logged for a while; the deferral had not been, and the
 * two are the same question asked of the same silence. A cover that defers
 * speaks no words, records no history and sends no client frame, so from
 * outside a STARVED cover and a cover that was never armed are the identical
 * observation — nothing at all. Measured on a graded retail run (allaai-c5,
 * 2026-09-13): 19 of 45 first-token stalls over 5s produced no cover line, and
 * the log could not say which of the two had happened.
 *
 * The starvation spec below is therefore the load-bearing one. Every other
 * property here can be observed through `speak`; that one cannot be observed
 * at all without the line it asserts.
 */

import { DEAD_AIR_COVER_MAX_MS } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLogger, type TestLogger } from "../_test-utils.ts";
import { createDeadAirCover, type DeadAirCover } from "./pipeline-dead-air.ts";

const COVER_MS = 1000;

/** The window armed for the Nth filler — the backoff `arm` applies. */
const windowFor = (fillersSpoken: number): number =>
  Math.min(COVER_MS * 2 ** fillersSpoken, Math.max(DEAD_AIR_COVER_MAX_MS, COVER_MS));

type Harness = {
  cover: DeadAirCover;
  log: TestLogger;
  spoken: string[];
  setCallerSpeaking: (v: boolean) => void;
  setToolCovering: (v: boolean) => void;
  setSpokeText: (v: boolean) => void;
};

function harness(): Harness {
  const spoken: string[] = [];
  const log = makeLogger();
  let callerSpeaking = false;
  let toolCovering = false;
  let spokeText = false;
  const cover = createDeadAirCover({
    coverMs: COVER_MS,
    callerSpeaking: () => callerSpeaking,
    toolCovering: () => toolCovering,
    spokeText: () => spokeText,
    speak: (phrase) => void spoken.push(phrase),
    log,
    sid: "s-1",
  });
  return {
    cover,
    log,
    spoken,
    setCallerSpeaking: (v) => {
      callerSpeaking = v;
    },
    setToolCovering: (v) => {
      toolCovering = v;
    },
    setSpokeText: (v) => {
      spokeText = v;
    },
  };
}

/** Every `log.info` call that reported a deferral, in order. */
const deferrals = (log: TestLogger): Record<string, unknown>[] =>
  log.info.mock.calls
    .filter(([message]) => message === "Pipeline dead-air cover deferred")
    .map(([, ctx]) => (ctx ?? {}) as Record<string, unknown>);

describe("createDeadAirCover", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("covers the turn's OPENING gap, armed at construction", async () => {
    // The property the whole module exists for: nothing has to arrive for the
    // cover to fire, so a slow first token is covered rather than unbounded.
    const h = harness();
    await vi.advanceTimersByTimeAsync(windowFor(0));
    expect(h.spoken).toHaveLength(1);
    expect(deferrals(h.log)).toHaveLength(0);
  });

  it("a DEFERRED cover says so, and names what filled the gap", async () => {
    const h = harness();
    h.setCallerSpeaking(true);
    await vi.advanceTimersByTimeAsync(windowFor(0));
    // Not spoken — the caller is talking, and the cover exists for silence.
    expect(h.spoken).toEqual([]);
    expect(deferrals(h.log)).toEqual([
      { sid: "s-1", reason: "caller-speaking", deferrals: 1, waitedMs: windowFor(0) },
    ]);
  });

  it("names a tool's own lines as the filler instead", async () => {
    const h = harness();
    h.setToolCovering(true);
    await vi.advanceTimersByTimeAsync(windowFor(0));
    expect(h.spoken).toEqual([]);
    expect(deferrals(h.log)[0]).toMatchObject({ reason: "tool-covering" });
  });

  it("a STARVED cover reports a RISING count, which is the only trace it leaves", async () => {
    // The case the log was added for. A predicate stuck true re-arms forever:
    // the caller hears nothing for the whole turn, and every other observable
    // — `speak`, history, the client's transcript — is identical to a turn
    // whose cover was never armed. The count is what separates them.
    const h = harness();
    h.setCallerSpeaking(true);
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(windowFor(0));
    expect(h.spoken).toEqual([]);
    expect(deferrals(h.log).map((c) => c.deferrals)).toEqual([1, 2, 3, 4]);
  });

  it("counts CONSECUTIVE deferrals — a spoken filler resets it", async () => {
    // Consecutive rather than cumulative, because what the number is for is
    // spotting starvation. A gap that keeps getting filled by the caller and
    // then gets covered is healthy, and must not read as a rising problem.
    const h = harness();
    h.setCallerSpeaking(true);
    await vi.advanceTimersByTimeAsync(windowFor(0));
    h.setCallerSpeaking(false);
    await vi.advanceTimersByTimeAsync(windowFor(0));
    expect(h.spoken).toHaveLength(1);
    h.setCallerSpeaking(true);
    await vi.advanceTimersByTimeAsync(windowFor(1));
    expect(deferrals(h.log).map((c) => c.deferrals)).toEqual([1, 1]);
  });

  it("reports the window that ACTUALLY elapsed, not the configured one", async () => {
    // `waitedMs` is the armed value, and the window doubles per filler spoken —
    // so a reader sees the backoff rather than having to infer it. Reporting
    // `coverMs` here would describe the first window forever.
    const h = harness();
    await vi.advanceTimersByTimeAsync(windowFor(0));
    h.setCallerSpeaking(true);
    await vi.advanceTimersByTimeAsync(windowFor(1));
    expect(deferrals(h.log)[0]).toMatchObject({ waitedMs: windowFor(1) });
    expect(windowFor(1)).not.toBe(COVER_MS);
  });

  it("a cleared cover neither fires nor defers", async () => {
    const h = harness();
    h.setCallerSpeaking(true);
    h.cover.clear();
    await vi.advanceTimersByTimeAsync(windowFor(0) * 4);
    expect(h.spoken).toEqual([]);
    expect(deferrals(h.log)).toHaveLength(0);
  });
});
