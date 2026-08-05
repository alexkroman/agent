// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * FUZZ HARNESS: randomized snapshot commits against the tool-call /
 * custom-event hooks, checking exactly-once delivery and completeness — the
 * watermark + `fired` cursor in hooks.ts is the thing under test.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
import type { AgentCustomEvent } from "./session-core-types.ts";
import type { ToolCallInfo } from "./types.ts";

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CAP = 200;

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

/** Complete one pending call, chosen at random — often out of arrival order. */
function completeRandomPending(c: Collections, r: () => number): void {
  const pending = c.toolCalls.filter((tc) => tc.status === "pending");
  const pick = pending[Math.floor(r() * pending.length)];
  if (!pick) return;
  c.toolCalls = c.toolCalls.map((tc) =>
    tc.callId === pick.callId ? { ...tc, status: "done" as const, result: '{"ok":true}' } : tc,
  );
}

function addEvent(c: Collections, seqs: Seqs, name: string): void {
  seqs.event += 1;
  c.customEvents = appendCapped(
    c.customEvents,
    { id: seqs.event, event: name, data: { n: seqs.event } },
    CAP,
  );
}

/** One random mutation of the snapshot collections. */
function mutate(c: Collections, seqs: Seqs, r: () => number): void {
  const roll = r();
  if (roll < 0.4) {
    addToolCall(c, seqs, r() < 0.5 ? "alpha" : "beta");
  } else if (roll < 0.7) {
    completeRandomPending(c, r);
  } else if (roll < 0.9) {
    addEvent(c, seqs, r() < 0.6 ? "ping" : "pong");
  } else {
    // Session reset: the server `reset` frame clears both collections.
    c.toolCalls = [];
    c.customEvents = [];
  }
}

const dupes = <T>(xs: T[]): T[] => xs.filter((x, i) => xs.indexOf(x) !== i);

/** What the hooks actually delivered for one seed, and what they owed. */
type SeedRun = {
  fired: { start: string[]; done: string[]; events: number[] };
  expected: { start: Set<string>; done: Set<string>; events: Set<number> };
};

/**
 * Drive one seed's commit sequence through all three hooks. Expectations are
 * everything that appeared in a COMMITTED snapshot, so a call created and
 * evicted inside one batch is not held against the hook.
 */
function runDeliverySeed(seed: number): SeedRun {
  const r = rng(seed);
  const core = createMockSessionCore({ state: "ready", started: true });
  const fired: SeedRun["fired"] = { start: [], done: [], events: [] };
  const expected: SeedRun["expected"] = { start: new Set(), done: new Set(), events: new Set() };

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
  for (let commit = 0; commit < 12; commit++) {
    const mutations = 1 + Math.floor(r() * 4);
    for (let m = 0; m < mutations; m++) mutate(c, seqs, r);
    act(() => core.update({ toolCalls: c.toolCalls, customEvents: c.customEvents }));
    for (const tc of c.toolCalls) {
      expected.start.add(tc.callId);
      if (tc.status === "done") expected.done.add(tc.callId);
    }
    for (const ce of c.customEvents) if (ce.event === "ping") expected.events.add(ce.id);
  }
  return { fired, expected };
}

describe("fuzz: tool-call + custom-event hook delivery", () => {
  it("delivers every settled tool call and matching event exactly once", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { fired, expected } = runDeliverySeed(seed);
      expect(dupes(fired.start), `seed ${seed}: duplicate start fires`).toEqual([]);
      expect(dupes(fired.done), `seed ${seed}: duplicate done fires`).toEqual([]);
      expect(dupes(fired.events), `seed ${seed}: duplicate events`).toEqual([]);
      expect(new Set(fired.start), `seed ${seed}: start delivery mismatch`).toEqual(expected.start);
      expect(new Set(fired.done), `seed ${seed}: done delivery mismatch`).toEqual(expected.done);
      expect(new Set(fired.events), `seed ${seed}: event delivery mismatch`).toEqual(
        expected.events,
      );
    }
  });

  it("overflows the cap without dropping or duplicating a delivery", () => {
    const core = createMockSessionCore({ state: "ready", started: true });
    const fired: string[] = [];
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult((_n, _res, tc) => fired.push(tc.callId)), { wrapper });

    // More tool calls than the snapshot cap, some settling only after the
    // window has slid past their arrival.
    const c: Collections = { toolCalls: [], customEvents: [] };
    const seqs: Seqs = { tool: 0, event: 0 };
    const r = rng(99);
    const everDone = new Set<string>();
    for (let i = 0; i < CAP + 60; i++) {
      addToolCall(c, seqs, "alpha");
      if (r() < 0.6) completeRandomPending(c, r);
      act(() => core.update({ toolCalls: c.toolCalls }));
      for (const tc of c.toolCalls) if (tc.status === "done") everDone.add(tc.callId);
    }
    expect(dupes(fired)).toEqual([]);
    expect(new Set(fired)).toEqual(everDone);
  });
});
