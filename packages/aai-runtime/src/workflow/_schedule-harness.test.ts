// Copyright 2026 the AAI authors. MIT license.
// The scheduled journal: every call is a task the scheduler releases, logged
// as a call/settle pair under the walk that made it — and the log readers the
// laws are written in.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  callArgs,
  createOpLog,
  deliveredTokens,
  type Ev,
  isGuardedTerminalMove,
  scheduleJournal,
} from "./_schedule-harness.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";

function scheduler(): fc.Scheduler {
  const [s] = fc.sample(fc.scheduler(), { numRuns: 1, seed: 1 });
  if (!s) throw new Error("fast-check produced no scheduler");
  return s;
}

describe("scheduleJournal", () => {
  test("a call waits for the scheduler, then logs call and ret under its walk", async () => {
    const s = scheduler();
    const log = createOpLog();
    const journal = scheduleJournal(createMemoryJournal(), {
      scheduler: s,
      log,
      arm: "direct",
      by: () => "p.d0.0",
    });
    const read = journal.getRun("wrun_none");
    expect(log.events.map((ev) => ev.kind)).toEqual(["call"]);
    await s.waitAll();
    await expect(read).resolves.toBeUndefined();
    expect(log.events).toEqual([
      { i: 0, kind: "call", method: "getRun", by: "p.d0.0", args: ["wrun_none"] },
      { i: 0, kind: "ret", method: "getRun", by: "p.d0.0", value: undefined },
    ]);
  });

  test("a rejection is logged as a throw and rethrown", async () => {
    const s = scheduler();
    const log = createOpLog();
    const journal = scheduleJournal(createMemoryJournal(), {
      scheduler: s,
      log,
      arm: "roundTrip",
      by: () => "d",
    });
    const record = {
      runId: "wrun_1",
      workflow: "w",
      status: "pending" as const,
      createdAt: 0,
      input: null,
    };
    const first = journal.createRun(record);
    await s.waitAll();
    await first;
    const second = journal.createRun(record).catch((err: unknown) => err);
    await s.waitAll();
    expect(await second).toBeInstanceOf(Error);
    expect(log.events.at(-1)).toMatchObject({ kind: "throw", method: "createRun" });
  });
});

describe("the log readers", () => {
  const events: Ev[] = [
    { i: 0, kind: "call", method: "deliverHook", by: "p.sig0.0", args: ["tok1", {}] },
    { i: 0, kind: "ret", method: "deliverHook", by: "p.sig0.0", value: "wrun_1" },
    { i: 1, kind: "call", method: "deliverHook", by: "p.sig0.1", args: ["tok2", {}] },
    { i: 1, kind: "ret", method: "deliverHook", by: "p.sig0.1", value: undefined },
  ];

  test("callArgs finds the arguments of the call an event settles", () => {
    expect(callArgs(events, 1)).toEqual(["tok2", {}]);
    expect(callArgs(events, 9)).toBeUndefined();
  });

  test("deliveredTokens counts only the deliveries that landed", () => {
    expect([...deliveredTokens(events)]).toEqual(["tok1"]);
  });

  test("isGuardedTerminalMove is a terminal setStatus carrying an expect", () => {
    const ev: Ev = { i: 0, kind: "ret", method: "setStatus", by: "d", value: true };
    expect(isGuardedTerminalMove(ev, ["wrun_1", "completed", {}, ["running"]])).toBe(true);
    expect(isGuardedTerminalMove(ev, ["wrun_1", "completed", {}, undefined])).toBe(false);
    expect(isGuardedTerminalMove(ev, ["wrun_1", "running", {}, ["pending"]])).toBe(false);
    expect(
      isGuardedTerminalMove({ ...ev, method: "getRun" }, ["wrun_1", "completed", {}, []]),
    ).toBe(false);
  });
});
