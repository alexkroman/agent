// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  applyHookOp,
  applyRunOp,
  applyStepOp,
  type Tables,
  type Targets,
} from "./_tenancy-journal-harness.ts";

const A = "tenancy-alpha" as const;

const tables = (): Tables => ({
  uploads: new Map(),
  slots: new Map(),
  events: new Map(),
  runs: new Map(),
  steps: new Map(),
  attempts: new Map(),
  holders: new Map(),
  sleeps: new Map(),
  hooks: new Map(),
});

/** The reference's targets: this tenant's bucket and nothing else. */
const own = (t: Tables): Targets => ({
  runRead: [],
  hookRelease: [t],
  hookDelivery: [t],
  attempts: t,
  events: [t],
});

const create = (t: Tables, runId: string) =>
  applyRunOp(
    t,
    { t: "createRun", slug: A, runId, workflow: "wf", input: undefined, createdAt: 1 },
    own(t),
  );

describe("the journal reference", () => {
  test("a run id is refused once taken", () => {
    const t = tables();
    expect(create(t, "r")).toEqual({ ok: undefined });
    expect(create(t, "r")).toEqual({ refused: "run-taken" });
  });

  test("setStatus is a compare-and-set, and only a TERMINAL move releases hooks", () => {
    const t = tables();
    create(t, "r");
    applyHookOp(t, { t: "claimHook", slug: A, runId: "r", key: "h", token: "tok" }, own(t));
    const set = (status: string, expect: readonly string[] | undefined) =>
      applyRunOp(
        t,
        { t: "setStatus", slug: A, runId: "r", status, result: undefined, expect },
        own(t),
      );
    expect(set("running", ["completed"])).toEqual({ ok: false });
    expect(set("running", ["pending"])).toEqual({ ok: true });
    expect(t.hooks.size).toBe(1);
    expect(set("completed", undefined)).toEqual({ ok: true });
    expect(t.hooks.size).toBe(0);
  });

  test("a getRun miss reads through only the buckets a leak would widen to", () => {
    const mine = tables();
    const theirs = tables();
    create(theirs, "r");
    const op = { t: "getRun", slug: A, runId: "r" } as const;
    expect(applyRunOp(mine, op, own(mine))).toEqual({ ok: undefined });
    expect(applyRunOp(mine, op, { ...own(mine), runRead: [theirs] })).toMatchObject({
      ok: { runId: "r" },
    });
  });

  test("claimAttempt counts DISTINCT holders, so a re-claim answers the same number", () => {
    const t = tables();
    const claim = (holder: string) =>
      applyStepOp(t, { t: "claimAttempt", slug: A, runId: "r", key: "k", holder }, own(t));
    expect(claim("walk-1")).toEqual({ ok: 1 });
    expect(claim("walk-1")).toEqual({ ok: 1 });
    expect(claim("walk-2")).toEqual({ ok: 2 });
  });

  test("a bare wake reaches ordinary sleeps only, and never an elapsed one", () => {
    const t = tables();
    const sleep = (key: string, wakeAt: number, kind: string) =>
      applyStepOp(
        t,
        { t: "claimSleep", slug: A, runId: "r", key, wakeAt, correlationId: "c", kind },
        own(t),
      );
    sleep("a", 100, "sleep");
    sleep("b", 100, "hookTimeout");
    sleep("c", 5, "sleep");
    const wake = (correlationIds: readonly string[] | undefined) =>
      applyStepOp(t, { t: "wakeSleeps", slug: A, runId: "r", now: 10, correlationIds }, own(t));
    expect(wake(undefined)).toEqual({ ok: 1 });
    expect(wake(["c"])).toEqual({ ok: 1 });
  });

  test("a hook token held by another wait is refused, naming the holder", () => {
    const t = tables();
    applyHookOp(t, { t: "claimHook", slug: A, runId: "r1", key: "h", token: "tok" }, own(t));
    expect(
      applyHookOp(t, { t: "claimHook", slug: A, runId: "r2", key: "h", token: "tok" }, own(t)),
    ).toEqual({ refused: "hook-token", holder: "r1" });
  });

  test("a delivered window cannot be closed, and a delivery takes a window once", () => {
    const t = tables();
    applyHookOp(t, { t: "claimHook", slug: A, runId: "r", key: "h", token: "tok" }, own(t));
    const deliver = () =>
      applyHookOp(t, { t: "deliverHook", slug: A, token: "tok", payload: "1" }, own(t));
    expect(deliver()).toEqual({ ok: "r" });
    expect(deliver()).toEqual({ ok: undefined });
    expect(applyHookOp(t, { t: "closeHook", slug: A, runId: "r", key: "h" }, own(t))).toEqual({
      ok: false,
    });
  });
});
