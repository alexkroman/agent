// Copyright 2026 the AAI authors. MIT license.
// Specs for the dead-air cover in pipeline-stream-parts.ts — the one latency
// filler the transport speaks on its own. Split out of pipeline-stream.test.ts,
// which owns the pure stream helpers and had no headroom under the 700-line cap.
//
// **The default harness configures NOTHING.** That is deliberate and is the
// regression this file exists for: the cover used to be enabled by
// `holdPhrase.length > 0`, `holdPhrase` was defaulted to `""`, and every spec
// here named a phrase to "exercise the machinery" — so the shipped default had
// no cover at all and nothing noticed. A spec that overrides an option must be
// about that option.

import {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEFAULT_DEAD_AIR_COVER_MS,
} from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import { useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createTtsTextCoalescer } from "./pipeline-stream.ts";
import { createStreamPartHandler } from "./pipeline-stream-parts.ts";

describe("createStreamPartHandler dead-air cover", () => {
  function harness(overrides: { deadAirCoverMs?: number; signal?: AbortSignal } = {}) {
    const spoken: string[] = [];
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      // Route through a real coalescer: a filler that only reaches the batch
      // buffer is not speech, and the tool window is exactly when nothing
      // arrives to flush it.
      sendTtsText: createTtsTextCoalescer((t) => spoken.push(t)).send,
      onTtsBoundary: () => undefined,
      onToolCall: () => undefined,
      emitError: () => undefined,
      log: silentLogger,
      sid: "t",
      ...overrides,
    });
    const toolCall = (id: string): void =>
      handler.handle({ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} });
    return { spoken, handler, toolCall };
  }

  useVirtualTime();

  test("an agent that configures nothing still gets cover", () => {
    // The regression. `deadAirCoverMs` has its own enable now, and its default
    // is on — a shipped agent hears filler after a real silence rather than
    // having the mechanism switched off by an unrelated empty string.
    const { spoken } = harness();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });

  test("covers the turn's opening gap, before any tool call exists", () => {
    // The failure this exists for: the cover was armed only by a `tool-call`
    // part, so the window between the committed user turn and the model's FIRST
    // stream part was uncovered and unbounded — a slow first token, or a
    // reasoning phase that emits no text, is silence the caller cannot
    // distinguish from a dropped call. Measured on tau2-bench retail with
    // gpt-5.5: 31.4s, ended only by the first tool call finally reaching the
    // filler of the day.
    const { spoken } = harness();
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    // The opening phrase, not a cover phrase: the cycle opens with "I'm still
    // checking on this.", which describes work the caller never heard start.
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
    expect(spoken.join("")).not.toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("a tool call at t=0 speaks nothing until the window elapses", () => {
    // The behaviour change. A turn opening with a tool call used to emit a
    // holding line immediately, on the structural bet that silence was coming
    // — paid on every such turn however fast the tool returned. Cover waits for
    // MEASURED silence instead, so a tool that answers in 300ms costs nothing.
    const { spoken, toolCall } = harness();
    toolCall("tc-1");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS - 1);
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });

  test("a tool call speaks no filler of its own", () => {
    // With one emit site the caller can never hear the opening filler twice a
    // beat apart. Guards the deleted `tool-call` emit branch not coming back:
    // the tool call re-arms the window and says nothing.
    const { spoken, toolCall } = harness();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    toolCall("tc-1");
    expect(spoken.join("").split(DEAD_AIR_OPENING_PHRASE).length - 1).toBe(1);
  });

  test("a turn that answers promptly pays nothing for the opening cover", () => {
    const { spoken, handler } = harness();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS - 1);
    handler.handle({ type: "text-delta", text: "Sure, here you go. " });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    expect(spoken.join("")).toBe("Sure, here you go. ");
  });

  test("covers a tool window that opens after the model has already spoken", () => {
    // The failure this exists for: the model says "Let me check that", then
    // chains tool calls for 15+ seconds. The old hold phrase was state-gated on
    // "has the model spoken this turn", so it stayed suppressed and the caller
    // heard nothing until the chain ended — by which point they have hung up.
    const { spoken, toolCall, handler } = harness();
    handler.handle({ type: "text-delta", text: "Let me check that for you. " });
    handler.handle({ type: "text-end" });
    toolCall("tc-1");
    expect(spoken.join("")).toBe("Let me check that for you. ");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(spoken.join("")).toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("a chain of fast tool calls cannot push the deadline out forever", () => {
    // The bug: `RestartableTimer.arm` clears and re-sets, so re-arming the
    // cover on every `tool-call` measured the deadline from the last CALL
    // rather than from the last thing the caller HEARD. A chain whose calls
    // each return inside the window therefore reset the countdown every time
    // and the cover never fired — precisely the silence it exists to break.
    // Measured on tau2-bench retail: zero fillers across 13.0s and 6.0s of
    // mid-authentication dead air, both ending in the caller asking "Hello?".
    const { spoken, toolCall } = harness();
    const step = DEFAULT_DEAD_AIR_COVER_MS - 1;
    toolCall("tc-1");
    // Six calls, each landing just inside the window and none preceded by
    // speech: 5x longer than the window in total, and under the re-arm this
    // stayed perfectly silent.
    for (let i = 2; i <= 6; i++) {
      vi.advanceTimersByTime(step);
      toolCall(`tc-${i}`);
    }
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });

  test("a tool call still re-opens the window after the model has spoken", () => {
    // The other half of the guard: a `text-delta` CLEARS the timer, so the
    // next tool call must be free to arm a fresh one. Declining to re-arm
    // while a window is already pending must not turn into never re-arming.
    const { spoken, toolCall, handler } = harness();
    toolCall("tc-1");
    handler.handle({ type: "text-delta", text: "Found it. " });
    handler.handle({ type: "text-end" });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 4);
    expect(spoken.join("")).toBe("Found it. ");
    toolCall("tc-2");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 4);
    // Names the phrase, the way every other spec here does. `not.toBe("Found
    // it. ")` was satisfied by the wrong phrase, an empty string or a duplicate
    // — it only ruled out "no further output". The model has spoken, so this is
    // a mid-turn gap and the cycle's first phrase is what covers it (the
    // opening phrase is for a turn that has said nothing yet).
    expect(spoken.join("")).toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("keeps covering a long tool chain, backing off between fillers", () => {
    const { spoken, toolCall } = harness();
    toolCall("tc-1");
    const covers = (): number =>
      DEAD_AIR_COVER_PHRASES.filter((p) => spoken.join("").includes(p)).length;
    // The opening phrase counts toward the backoff, so the first cycle phrase
    // is two windows out rather than one — under a second of silence between
    // two fillers reads as chatter.
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(covers()).toBe(0);
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(covers()).toBe(0);
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(covers()).toBe(1);
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 8);
    expect(covers()).toBeGreaterThanOrEqual(2);
  });

  test("the backoff flattens at DEAD_AIR_COVER_MAX_MS instead of drifting silent", () => {
    // Uncapped doubling put a 90s chain's fillers 16s and then 32s apart — the
    // dead air the cover exists to prevent, at the tail of exactly the long
    // chains it exists for. Measured on the tau2-bench retail runs, whose 45s
    // tool chains ended in a silent 15s stretch.
    const { spoken, toolCall } = harness();
    toolCall("tc-1");
    // Ramp past the doubling phase (three fillers gets the wait to the cap).
    vi.advanceTimersByTime(DEAD_AIR_COVER_MAX_MS * 4);
    const before = spoken.length;
    // From here every window is the cap, so N more windows means N more fillers.
    vi.advanceTimersByTime(DEAD_AIR_COVER_MAX_MS * 3);
    expect(spoken.length - before).toBe(3);
  });

  test("a base above DEAD_AIR_COVER_MAX_MS is not clamped below itself", () => {
    // The ceiling is a backoff cap, not a second deadline. With the base fixed
    // it could be a constant; with the base an author's, `min(base, 8000)`
    // would give an agent asking for one filler every 20s its first at 8s.
    const { spoken } = harness({ deadAirCoverMs: 20_000 });
    vi.advanceTimersByTime(DEAD_AIR_COVER_MAX_MS);
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(20_000 - DEAD_AIR_COVER_MAX_MS);
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });

  test("the opening filler does not consume a cover phrase's turn in the cycle", () => {
    // Sharing one counter between the backoff and the phrase index made the
    // caller hear the opening filler and then skip to the second cover phrase.
    const { spoken, toolCall } = harness();
    toolCall("tc-1");
    vi.advanceTimersByTime(DEAD_AIR_COVER_MAX_MS * 2);
    expect(spoken.join("")).toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("speech cancels a pending cover", () => {
    const { spoken, toolCall, handler } = harness();
    toolCall("tc-1");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS - 1);
    handler.handle({ type: "text-delta", text: "Found it. " });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    for (const phrase of [DEAD_AIR_OPENING_PHRASE, ...DEAD_AIR_COVER_PHRASES]) {
      expect(spoken.join("")).not.toContain(phrase);
    }
  });

  test("dispose() stops a cover from firing into the silence after the turn", () => {
    const { spoken, toolCall, handler } = harness();
    toolCall("tc-1");
    handler.dispose();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    expect(spoken).toEqual([]);
  });

  test("a barge-in abort stops a pending cover from firing", () => {
    // Barge-in during a tool execution: dispose() waits on the parked
    // fullStream read, so the abort signal is what must kill the timer —
    // otherwise the filler is spoken into post-cancel silence AND appended
    // to `accumulated`, polluting the interrupted-turn history.
    const ctl = new AbortController();
    const { spoken, toolCall } = harness({ signal: ctl.signal });
    toolCall("tc-1");
    ctl.abort();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    expect(spoken).toEqual([]);
  });

  test("an unaborted signal leaves the cover working", () => {
    const ctl = new AbortController();
    const { spoken, toolCall } = harness({ signal: ctl.signal });
    toolCall("tc-1");
    // Three base windows: the opening phrase lands at one and counts toward
    // the backoff, so the first cycle phrase is two more out.
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 3);
    expect(spoken.join("")).toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("deadAirCoverMs: 0 disables the cover", () => {
    // The cover has its OWN kill switch now. It used to share `holdPhrase`'s —
    // "one kill switch for filler speech, not two" — and that coupling is the
    // defect this file was split out for: once `holdPhrase` defaulted to `""`,
    // the shipped default silently had no dead-air cover at all.
    const { spoken, toolCall } = harness({ deadAirCoverMs: 0 });
    toolCall("tc-1");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    expect(spoken).toEqual([]);
  });

  test("filler never reaches onDelta, so it stays out of history", () => {
    // `record: false` is what keeps the committed message dialogue and the live
    // caption faithful to the audio. Recording it cost twice: context spent
    // restating filler on every later turn, and a model shown its own filler as
    // an example of what its turns look like.
    const deltas: string[] = [];
    const spoken: string[] = [];
    const handler = createStreamPartHandler({
      onDelta: (d) => deltas.push(d),
      sendTtsText: createTtsTextCoalescer((t) => spoken.push(t)).send,
      onToolCall: () => undefined,
      emitError: () => undefined,
      log: silentLogger,
      sid: "t",
    });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    handler.handle({ type: "text-delta", text: "Here it is." });
    handler.dispose();
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
    expect(deltas.join("")).not.toContain(DEAD_AIR_OPENING_PHRASE);
    expect(deltas.join("")).toContain("Here it is.");
  });

  test("filler is suppressed while the caller is speaking", () => {
    // Filler is silence-cover, so playing it over a live utterance is worse
    // than the silence it hides: measured on EVA's turn-taking metric it
    // registers as an agent interruption — 1.5s of simultaneous speech on one
    // turn, scored 0.13 out of 1.
    let speaking = true;
    const spoken: string[] = [];
    createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: createTtsTextCoalescer((t) => spoken.push(t)).send,
      onToolCall: () => undefined,
      emitError: () => undefined,
      callerSpeaking: () => speaking,
      log: silentLogger,
      sid: "t",
    });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(spoken).toEqual([]);
    // Re-armed rather than abandoned: the next gap still gets covered.
    speaking = false;
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });
});
