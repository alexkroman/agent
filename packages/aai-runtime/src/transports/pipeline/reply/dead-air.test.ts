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

import {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_OPENING_PHRASE,
  DEAD_AIR_OPENING_TARGET_MS,
  DEAD_AIR_TOOL_COVER_MS,
  DEFAULT_DEAD_AIR_COVER_MS,
} from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLogger, type TestLogger } from "../../../_logger-test-utils.ts";
import { createDeadAirCover, type DeadAirCover, openingCoverMs } from "./dead-air.ts";

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

describe("openingCoverMs — the opening window, anchored on the caller's last word", () => {
  const TARGET = DEAD_AIR_OPENING_TARGET_MS;

  it("is the target minus the caller's wait already spent", () => {
    // A commit 1.4s after the last word (the measured p50) leaves 3.2s.
    expect(openingCoverMs(DEFAULT_DEAD_AIR_COVER_MS, 10_000, 11_400)).toBe(TARGET - 1400);
  });

  it("fires at once when the caller has already waited the target", () => {
    expect(openingCoverMs(DEFAULT_DEAD_AIR_COVER_MS, 0, TARGET + 2000)).toBe(0);
  });

  it("keeps the fixed window without a stop time, and stays off at 0", () => {
    expect(openingCoverMs(DEFAULT_DEAD_AIR_COVER_MS, undefined, 5000)).toBe(
      DEFAULT_DEAD_AIR_COVER_MS,
    );
    expect(openingCoverMs(0, 1000, 1500)).toBe(0);
  });

  it("an author's window shifts the target by what it differs from the default", () => {
    const authored = DEFAULT_DEAD_AIR_COVER_MS + 1000;
    expect(openingCoverMs(authored, 0, 1000)).toBe(TARGET + 1000 - 1000);
  });

  it("arms the first window from it, and backs off from coverMs after", async () => {
    vi.useFakeTimers();
    try {
      const spoken: string[] = [];
      createDeadAirCover({
        coverMs: COVER_MS,
        openingMs: 300,
        callerSpeaking: () => false,
        toolCovering: () => false,
        spokeText: () => false,
        speak: (phrase) => void spoken.push(phrase),
        log: makeLogger(),
        sid: "s-1",
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(spoken).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(spoken).toEqual([DEAD_AIR_OPENING_PHRASE]);
      // The second window is the normal backoff from coverMs, not from 300.
      await vi.advanceTimersByTimeAsync(windowFor(1) - 1);
      expect(spoken).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spoken).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a tool call and the anchored opening window", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const OPENING_MS = 3000;

  function toolHarness(openingMs: number | undefined) {
    const spoken: string[] = [];
    let spokeText = false;
    const cover = createDeadAirCover({
      coverMs: DEFAULT_DEAD_AIR_COVER_MS,
      openingMs,
      callerSpeaking: () => false,
      toolCovering: () => false,
      spokeText: () => spokeText,
      speak: (phrase) => void spoken.push(phrase),
      log: makeLogger(),
      sid: "s-1",
    });
    const speakText = (): void => {
      spokeText = true;
    };
    return { cover, spoken, speakText };
  }

  it("does not pull the opening filler in front of the anchored target", async () => {
    // The early filler this guards against: the tool window would fire it
    // while the answer is due, and the answer then waits out its audio.
    const h = toolHarness(OPENING_MS);
    await vi.advanceTimersByTimeAsync(100);
    h.cover.onToolCall();
    await vi.advanceTimersByTimeAsync(100 + DEAD_AIR_TOOL_COVER_MS);
    expect(h.spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(OPENING_MS - 200 - DEAD_AIR_TOOL_COVER_MS);
    expect(h.spoken).toEqual([DEAD_AIR_OPENING_PHRASE]);
  });

  it("after the opening filler, the chain keeps the tool window's cadence", async () => {
    const h = toolHarness(OPENING_MS);
    h.cover.onToolCall();
    await vi.advanceTimersByTimeAsync(OPENING_MS);
    expect(h.spoken).toHaveLength(1);
    // The backoff doubles from the tool window, not from coverMs.
    await vi.advanceTimersByTimeAsync(DEAD_AIR_TOOL_COVER_MS * 2);
    expect(h.spoken).toHaveLength(2);
  });

  it("still pulls a gap AFTER the model spoke in to the tool window", async () => {
    const h = toolHarness(OPENING_MS);
    h.speakText();
    h.cover.clear(); // what a `text-delta` does
    h.cover.onToolCall();
    await vi.advanceTimersByTimeAsync(DEAD_AIR_TOOL_COVER_MS);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]).not.toBe(DEAD_AIR_OPENING_PHRASE);
  });

  it("without an anchor the tool window still pulls the opening in", async () => {
    // No word timings (another STT, a typed turn): the fallback is a fixed
    // window from the commit, which is no estimate of the caller's wait.
    const h = toolHarness(undefined);
    h.cover.onToolCall();
    await vi.advanceTimersByTimeAsync(DEAD_AIR_TOOL_COVER_MS - 1);
    expect(h.spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spoken).toEqual([DEAD_AIR_OPENING_PHRASE]);
  });
});
