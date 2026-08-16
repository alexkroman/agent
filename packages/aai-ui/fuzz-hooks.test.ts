// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * FUZZ HARNESS: randomized snapshot commits against the tool-call /
 * custom-event hooks, checking exactly-once delivery and completeness — the
 * watermark + `fired` cursor in hooks.ts is the thing under test.
 *
 * Driven by fast-check: the generated value is the whole commit script (a list
 * of commits, each a list of mutations), so a failure SHRINKS to the shortest
 * script that still breaks delivery — usually two or three mutations — instead
 * of reporting a seed and a 40-line op log to read by hand.
 */

import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
import type { AgentCustomEvent } from "./session-core-types.ts";
import type { ToolCallInfo } from "./types.ts";

const CAP = 200;

/** Enough commits to slide the snapshot window well past its cap. */
const OVERFLOW_STEPS = CAP + 60;

function appendCapped<T>(list: readonly T[], item: T, cap: number): T[] {
  if (list.length < cap) return [...list, item];
  const next = list.slice(list.length - cap + 1);
  next.push(item);
  return next;
}

/** The two capped collections a session snapshot carries for these hooks. */
type Collections = { toolCalls: ToolCallInfo[]; customEvents: AgentCustomEvent[] };

/** Counters mirroring the message handlers' monotonic sequence numbers. */
type Seqs = { tool: number; event: number };

/**
 * One mutation of the snapshot collections. `pick` indexes the pending calls
 * modulo their count, so the choice stays meaningful however many are pending
 * when the mutation runs — a state-dependent selection fast-check cannot know
 * at generation time.
 */
type Mutation =
  | { kind: "addToolCall"; name: "alpha" | "beta" }
  | { kind: "completePending"; pick: number }
  | { kind: "addEvent"; name: "ping" | "pong" }
  | { kind: "reset" };

function addToolCall(c: Collections, seqs: Seqs, name: string): void {
  seqs.tool += 1;
  c.toolCalls = appendCapped(
    c.toolCalls,
    {
      callId: `tc-${seqs.tool}`,
      name,
      args: {},
      status: "pending",
      seq: seqs.tool,
      afterMessageId: -1,
    },
    CAP,
  );
}

/**
 * Complete one pending call — often out of arrival order. Returns the call id
 * it settled, or `null` when there was nothing pending: `pick` indexes a
 * state-dependent set, so the no-op is normal and is exactly why
 * {@link Reached} floors the settles that DID happen.
 */
function completePending(c: Collections, pick: number): string | null {
  const pending = c.toolCalls.filter((tc) => tc.status === "pending");
  const chosen = pending[pick % pending.length];
  if (!chosen) return null;
  c.toolCalls = c.toolCalls.map((tc) =>
    tc.callId === chosen.callId ? { ...tc, status: "done" as const, result: '{"ok":true}' } : tc,
  );
  return chosen.callId;
}

function addEvent(c: Collections, seqs: Seqs, name: string): void {
  seqs.event += 1;
  c.customEvents = appendCapped(
    c.customEvents,
    { id: seqs.event, event: name, data: { n: seqs.event } },
    CAP,
  );
}

/**
 * States the generator must actually reach, asserted as floors after each
 * property.
 *
 * fast-check has no coverage-floor mechanism (`fc.statistics` only prints), and
 * an all-green property proves nothing about a state the generator never
 * entered — see "Property tests run on fast-check" in the root guide.
 *
 * Every assertion in this file compares a delivered set against an expected
 * set, so a run in which nothing was ever settled, emitted or evicted compares
 * two empty sets and passes. These floors are what separate "delivery is
 * exactly-once" from "there was no delivery". *
 * Each floor sits under the OBSERVED MINIMUM across the runs recorded beside
 * it, not at a fixed fraction of the mean. These distributions have long left
 * tails — a counter averaging 38 was measured at 3 on one run — because what a
 * walk reaches is correlated within a run rather than independent per step, so
 * a floor placed under the mean flakes. The job of the floor is to catch a
 * state that is NEVER reached, not to pin how often; a state whose whole range
 * is small therefore gets `> 0`, which is still the assertion that matters.
 */
type Reached = {
  /** Tool calls the script property delivered through `useToolResult`. */
  scriptDones: number;
  /** Ping events delivered through `useEvent` (the name filter really matched). */
  scriptEvents: number;
  /** `reset` mutations that cleared a NON-empty collection. */
  clearingResets: number;
  /** Settles in the overflow property that found a pending call. */
  overflowSettles: number;
  /**
   * …of those, ones settling a call that arrived at an EARLIER commit, so the
   * snapshot window had slid since — the watermark cursor's actual job.
   */
  lateSettles: number;
};
const reached: Reached = {
  scriptDones: 0,
  scriptEvents: 0,
  clearingResets: 0,
  overflowSettles: 0,
  lateSettles: 0,
};

function applyMutation(c: Collections, seqs: Seqs, m: Mutation): void {
  if (m.kind === "addToolCall") {
    addToolCall(c, seqs, m.name);
  } else if (m.kind === "completePending") {
    completePending(c, m.pick);
  } else if (m.kind === "addEvent") {
    addEvent(c, seqs, m.name);
  } else {
    // Session reset: the server `reset` frame clears both collections.
    if (c.toolCalls.length > 0 || c.customEvents.length > 0) reached.clearingResets += 1;
    c.toolCalls = [];
    c.customEvents = [];
  }
}

/**
 * Mutation weights mirror the original harness's roll thresholds: adds
 * dominate, resets are rare. Weighting matters more than it looks — an even
 * split would spend most of the run on resets and empty collections, which is
 * the state where these hooks have nothing to get wrong.
 */
const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("addToolCall" as const),
      name: fc.constantFrom("alpha" as const, "beta" as const),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("completePending" as const),
      pick: fc.nat({ max: 1000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("addEvent" as const),
      name: fc.constantFrom("ping" as const, "pong" as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reset" as const) }) },
);

/** A commit script: each entry is one snapshot commit's batch of mutations. */
const scriptArb = fc.array(fc.array(mutationArb, { minLength: 1, maxLength: 4 }), {
  minLength: 1,
  maxLength: 12,
});

const dupes = <T>(xs: T[]): T[] => xs.filter((x, i) => xs.indexOf(x) !== i);

/** What the hooks actually delivered for one script, and what they owed. */
type Run = {
  fired: { start: string[]; done: string[]; events: number[] };
  expected: { start: Set<string>; done: Set<string>; events: Set<number> };
};

/**
 * Drive one commit script through all three hooks. Expectations are everything
 * that appeared in a COMMITTED snapshot, so a call created and evicted inside
 * one batch is not held against the hook.
 */
function runScript(script: Mutation[][]): Run {
  const core = createMockSessionCore({ state: "ready", started: true });
  const fired: Run["fired"] = { start: [], done: [], events: [] };
  const expected: Run["expected"] = { start: new Set(), done: new Set(), events: new Set() };

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SessionProvider, { value: core }, children);
  renderHook(
    () => {
      useToolCallStart((tc) => fired.start.push(tc.callId));
      useToolResult((_name, _result, tc) => fired.done.push(tc.callId));
      useEvent<{ n: number }>("ping", (data) => fired.events.push(data.n));
    },
    { wrapper },
  );

  const c: Collections = { toolCalls: [], customEvents: [] };
  const seqs: Seqs = { tool: 0, event: 0 };
  for (const batch of script) {
    for (const m of batch) applyMutation(c, seqs, m);
    act(() => core.update({ toolCalls: c.toolCalls, customEvents: c.customEvents }));
    for (const tc of c.toolCalls) {
      expected.start.add(tc.callId);
      if (tc.status === "done") expected.done.add(tc.callId);
    }
    for (const ce of c.customEvents) if (ce.event === "ping") expected.events.add(ce.id);
  }
  reached.scriptDones += fired.done.length;
  reached.scriptEvents += fired.events.length;
  return { fired, expected };
}

/**
 * Record what one overflow settle exercised, for {@link Reached}.
 *
 * Its own function rather than a branch inside `runOverflow`'s loop: that put a
 * conditional inside a loop inside a loop and took the driver past Biome's
 * cognitive-complexity cap, which is the right signal — the loop should read as
 * "add a call, settle what the script names, commit".
 */
function noteSettle(settled: string | null, step: number): void {
  if (settled === null) return;
  reached.overflowSettles += 1;
  // One call is added per step, so `tc-N` arrived at step N-1. Settling later
  // than that is the case this property exists for: the snapshot window has
  // slid since the call was delivered as pending.
  if (Number(settled.slice("tc-".length)) - 1 < step) reached.lateSettles += 1;
}

/**
 * Push more tool calls through `useToolResult` than the snapshot cap holds,
 * settling the ones the script names at the step it names, so the window slides
 * past a call's arrival before it settles.
 */
function runOverflow(settles: readonly { at: number; pick: number }[]): {
  fired: string[];
  everDone: Set<string>;
} {
  const core = createMockSessionCore({ state: "ready", started: true });
  const fired: string[] = [];
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SessionProvider, { value: core }, children);
  renderHook(() => useToolResult((_n, _res, tc) => fired.push(tc.callId)), { wrapper });

  const byStep = new Map<number, number[]>();
  for (const { at, pick } of settles) byStep.set(at, [...(byStep.get(at) ?? []), pick]);

  const c: Collections = { toolCalls: [], customEvents: [] };
  const seqs: Seqs = { tool: 0, event: 0 };
  const everDone = new Set<string>();
  for (let step = 0; step < OVERFLOW_STEPS; step++) {
    addToolCall(c, seqs, "alpha");
    for (const pick of byStep.get(step) ?? []) noteSettle(completePending(c, pick), step);
    act(() => core.update({ toolCalls: c.toolCalls }));
    for (const tc of c.toolCalls) if (tc.status === "done") everDone.add(tc.callId);
  }
  return { fired, everDone };
}

describe("fuzz: tool-call + custom-event hook delivery", () => {
  it("delivers every settled tool call and matching event exactly once", () => {
    fc.assert(
      fc.property(scriptArb, (script) => {
        const { fired, expected } = runScript(script);
        expect(dupes(fired.start), "duplicate start fires").toEqual([]);
        expect(dupes(fired.done), "duplicate done fires").toEqual([]);
        expect(dupes(fired.events), "duplicate events").toEqual([]);
        expect(new Set(fired.start), "start delivery mismatch").toEqual(expected.start);
        expect(new Set(fired.done), "done delivery mismatch").toEqual(expected.done);
        expect(new Set(fired.events), "event delivery mismatch").toEqual(expected.events);
      }),
      { numRuns: 100 },
    );

    // Coverage floors — see `Reached` for how these are placed. Ranges are
    // over 17 runs. Without them the six set comparisons above are satisfied by
    // a script that never settled a call, never emitted a ping, never reset.
    expect(reached.scriptDones, "no tool call was ever delivered as done").toBeGreaterThan(50); // 175-264
    expect(reached.scriptEvents, "no matching custom event was ever delivered").toBeGreaterThan(35); // 120-159
    expect(reached.clearingResets, "no reset ever cleared a non-empty snapshot").toBeGreaterThan(
      25,
    ); // 93-132
  });

  it("overflows the cap without dropping or duplicating a delivery", () => {
    // The step COUNT is fixed — the point is to push more calls than the
    // snapshot cap — so the only generated part is which steps also settle a
    // call, letting the window slide past a call's arrival before it settles.
    //
    // Settles are a SPARSE list of (step, pick) rather than one option per
    // step: a fixed-length array shrinks to 260 entries of mostly `null`,
    // which prints as a wall and buries the one entry that matters. This form
    // shrinks to the handful of settles actually needed to break delivery.
    const settleArb = fc.array(
      fc.record({ at: fc.nat({ max: OVERFLOW_STEPS - 1 }), pick: fc.nat({ max: 1000 }) }),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(settleArb, (settles) => {
        const { fired, everDone } = runOverflow(settles);
        expect(dupes(fired)).toEqual([]);
        expect(new Set(fired)).toEqual(everDone);
      }),
      // Each run drives 260 commits through React, so this one is expensive;
      // the interesting variation is which calls settle late, not how many runs.
      { numRuns: 10 },
    );

    // Coverage floors — see `Reached`. `settleArb` may generate an empty list,
    // and `pick` indexes a state-dependent set, so with no floor this property
    // is satisfied by ten runs that settled nothing at all: `fired` and
    // `everDone` would both be empty and the watermark cursor — the thing under
    // test — would never be asked a question.
    expect(reached.overflowSettles, "no call was ever settled past the cap").toBeGreaterThan(5); // 28-58
    expect(
      reached.lateSettles,
      "every settle landed on the commit the call arrived on — the window never slid under one",
    ).toBeGreaterThan(4); // 24-51
  });
});
