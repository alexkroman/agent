// Copyright 2026 the AAI authors. MIT license.
/**
 * `workflow-wdk.ts` is mostly one-line delegation to the installed WDK, and
 * this spec covers the one method that is not: `streamTail`, which has to build
 * a readable in order to ask it for an index and must then throw that readable
 * away properly.
 *
 * `workflow/api` is mocked rather than installed: its `getRun` resolves a World
 * when CALLED, so a real one would need a `.workflow-data/` directory or a
 * Postgres — the exact reason the module doc gives for confining these imports
 * to one file.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { isRunNotFound } from "./workflow-wdk.ts";

const getReadable = vi.fn();
/**
 * What `workflow/api`'s `getRun` hands back, as much of it as this spec drives.
 *
 * Declared once, on the mock, rather than cast at each call site: four
 * `as unknown as` on one shape is the concentration that means a missing type,
 * and a cast would also stop reporting the day a method is ADDED here.
 */
type FakeRun = { getReadable: typeof getReadable; cancel?: () => Promise<void> };

const getRun = vi.fn((_runId: string): FakeRun => ({ getReadable }));

vi.mock("workflow/api", () => ({
  getRun: (runId: string) => getRun(runId),
  resumeHook: vi.fn(),
  start: vi.fn(),
}));
// FAITHFUL to the real predicates, which check `name` rather than the prototype
// (their own cross-copy-safe design). The stub used to answer `false`
// unconditionally, which made every not-found translation in this adapter — the
// three that turn a missing run into `undefined`, `false` and `0` — unreachable
// from its own spec.
// The factory is HOISTED above every top-level binding, so the predicate is
// inlined rather than shared — `vi.mock` cannot close over a `const` declared
// here (`Cannot access 'named' before initialization`).
vi.mock("workflow/errors", () => ({
  HookNotFoundError: {
    is: (value: unknown) => value instanceof Error && value.name === "HookNotFoundError",
  },
  WorkflowRunNotFoundError: {
    is: (value: unknown) => value instanceof Error && value.name === "WorkflowRunNotFoundError",
  },
  EntityConflictError: {
    is: (value: unknown) => value instanceof Error && value.name === "EntityConflictError",
  },
}));
/**
 * As much of a World as this spec drives: one run read, by id.
 *
 * Declared on the mock for the same reason {@link FakeRun} is — and the default
 * REJECTS, which is what every test written before `cancel` read a status keeps
 * exercising: a probe that cannot answer leaves the write in charge.
 */
type FakeWorld = { runs: { get: (runId: string) => Promise<{ status: string }> } };

const getWorld = vi.fn(
  (): FakeWorld => ({ runs: { get: () => Promise.reject(new Error("no world here")) } }),
);

vi.mock("workflow/runtime", () => ({ getWorld: () => getWorld() }));

/** A world whose one run reads back at `status`. */
function worldReporting(status: string): FakeWorld {
  return { runs: { get: () => Promise.resolve({ status }) } };
}

const { wdkAdapter } = await import("./workflow-wdk.ts");

/**
 * A stand-in for what `getReadable()` really returns: a stream that is ALREADY
 * live behind a background pump, so cancelling it is the only thing that frees
 * the world reader underneath.
 */
function fakeReadable(tailIndex: number): {
  getTailIndex: () => Promise<number>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return { getTailIndex: () => Promise.resolve(tailIndex), cancel: vi.fn(async () => undefined) };
}

beforeEach(() => {
  getReadable.mockReset();
  getRun.mockClear();
});

test("streamTail cancels the readable it built to ask for the index", async () => {
  const readable = fakeReadable(4);
  getReadable.mockReturnValue(readable);

  await expect(wdkAdapter().streamTail("wrun_1", {})).resolves.toBe(4);

  // The leak this exists to prevent: `getReadable()` opens a world reader via a
  // background pump, and nothing else ever cancels this one.
  expect(readable.cancel).toHaveBeenCalledTimes(1);
});

test("streamTail cancels once per call, so a polling reader frees what it opened", async () => {
  const readables = Array.from({ length: 15 }, (_, i) => fakeReadable(i));
  for (const r of readables) getReadable.mockReturnValueOnce(r);

  for (const _ of readables) {
    await wdkAdapter().streamTail("wrun_1", {});
  }

  expect(readables.filter((r) => r.cancel.mock.calls.length === 1)).toHaveLength(15);
});

test("streamTail cancels even when the index read fails", async () => {
  const cancel = vi.fn(async () => undefined);
  getReadable.mockReturnValue({
    getTailIndex: () => Promise.reject(new Error("world is gone")),
    cancel,
  });

  await expect(wdkAdapter().streamTail("wrun_1", {})).rejects.toThrow("world is gone");
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("streamTail reports the index even when the cancel rejects", async () => {
  const cancel = vi.fn(() => Promise.reject(new Error("already errored")));
  getReadable.mockReturnValue({ getTailIndex: () => Promise.resolve(2), cancel });

  // A cancel that fails has nothing to tell a caller who asked for an index —
  // and must not turn a good answer into a rejection or an unhandled one.
  await expect(wdkAdapter().streamTail("wrun_1", {})).resolves.toBe(2);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("streamTail passes the stream options through and omits absent ones", async () => {
  getReadable.mockReturnValue(fakeReadable(0));

  await wdkAdapter().streamTail("wrun_1", { namespace: "transcript", startIndex: undefined });

  expect(getRun).toHaveBeenCalledWith("wrun_1");
  expect(getReadable).toHaveBeenCalledWith({ namespace: "transcript" });
});

test("readStream hands the readable to the caller WITHOUT cancelling it", async () => {
  const readable = fakeReadable(0);
  getReadable.mockReturnValue(readable);

  const returned = wdkAdapter().readStream("wrun_1", { startIndex: -1 });

  expect(returned).toBe(readable);
  // The counterpart of `streamTail`: here the CALLER owns the cancel, because
  // the caller is the one still reading.
  expect(readable.cancel).not.toHaveBeenCalled();
  expect(getReadable).toHaveBeenCalledWith({ startIndex: -1 });
});

describe("a run that is gone is an ANSWER, however the DevKit wraps it", () => {
  /**
   * `wakeUp` re-throws as `new Error("Failed to wake up run …", { cause })`, so a
   * predicate reading one error's `name` answered false for the one case it
   * exists to catch — and the public API turned `{ woken: 0 }` into a 500.
   * Measured against a deployed agent on a well-formed run id nobody had issued.
   */
  const notFound = (): Error => {
    const err = new Error('Workflow run "wrun_x" not found');
    err.name = "WorkflowRunNotFoundError";
    return err;
  };

  test("sees it through one layer of wrapping", () => {
    const wrapped = new Error("Failed to wake up run wrun_x: nope", { cause: notFound() });
    expect(isRunNotFound(wrapped)).toBe(true);
  });

  test("still sees a bare one", () => {
    expect(isRunNotFound(notFound())).toBe(true);
  });

  test("does not mistake an unrelated failure for it", () => {
    // The direction that matters: reporting "no such run" for a lost database
    // would tell a caller polling a live run that it had been swept.
    expect(isRunNotFound(new Error("connection terminated unexpectedly"))).toBe(false);
  });

  test("terminates on a cause CYCLE rather than hanging the error path", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(isRunNotFound(a)).toBe(false);
  });
});

describe("cancelling a run that is already over is an ANSWER, not a 500", () => {
  /**
   * The shape a world really throws, and the one the not-found predicate could
   * not see. Measured against a real Postgres world under `aai dev`: `DELETE
   * /workflows/runs/<id>` on a COMPLETED run logged `Cannot transition run from
   * terminal state "completed"` and answered `500 Internal server error` — the
   * two-tabs race the route's own comment calls ordinary.
   */
  const terminalConflict = (): Error => {
    const err = new Error('Cannot transition run from terminal state "completed"');
    err.name = "EntityConflictError";
    return err;
  };

  test("a completed run answers false rather than throwing", async () => {
    getRun.mockReturnValue({
      getReadable,
      cancel: () => Promise.reject(terminalConflict()),
    });

    await expect(wdkAdapter().cancel("wrun_x")).resolves.toBe(false);
  });

  test("so does one wrapped in the DevKit's own re-throw", async () => {
    getRun.mockReturnValue({
      getReadable,
      cancel: () =>
        Promise.reject(new Error("Failed to cancel run wrun_x", { cause: terminalConflict() })),
    });

    await expect(wdkAdapter().cancel("wrun_x")).resolves.toBe(false);
  });

  test("a live run still cancels, and reports that it did", async () => {
    getRun.mockReturnValue({
      getReadable,
      cancel: () => Promise.resolve(undefined),
    });

    await expect(wdkAdapter().cancel("wrun_x")).resolves.toBe(true);
  });

  test("an unrelated failure still propagates", async () => {
    // The direction that matters: swallowing a lost database would report the
    // run as finished to a caller whose Stop button did nothing.
    getRun.mockReturnValue({
      getReadable,
      cancel: () => Promise.reject(new Error("connection terminated unexpectedly")),
    });

    await expect(wdkAdapter().cancel("wrun_x")).rejects.toThrow(/connection terminated/);
  });

  test("a run that is ALREADY cancelled resolves false — this call did not end it", async () => {
    // The one terminal status `cancel` itself produces, and the only one a
    // world accepts a second time without throwing (see `isRunOver`'s doc), so
    // the catch below cannot tell it from a live cancel. `WorkflowClient.cancel`
    // promises "true when this call is what ended it", and `completed` and
    // `failed` already answer false — a caller who clicks Stop twice, or whose
    // retry redelivers, was told twice that it had stopped the run.
    getWorld.mockReturnValue(worldReporting("cancelled"));
    const cancel = vi.fn(() => Promise.resolve(undefined));
    getRun.mockReturnValue({ getReadable, cancel });

    await expect(wdkAdapter().cancel("wrun_x")).resolves.toBe(false);
    // And nothing is written: a run that is over needs no second transition.
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a live run reads as live and still cancels", async () => {
    getWorld.mockReturnValue(worldReporting("running"));
    getRun.mockReturnValue({ getReadable, cancel: () => Promise.resolve(undefined) });

    await expect(wdkAdapter().cancel("wrun_x")).resolves.toBe(true);
  });

  test("a status read that FAILS decides nothing — the write still answers", async () => {
    // The probe is an optimization on one status, not a gate: a read that
    // cannot answer must leave the existing translation in charge, or a
    // transient fault on the read would report a live run as already over.
    getWorld.mockReturnValue({
      runs: { get: () => Promise.reject(new Error("connection terminated unexpectedly")) },
    });
    getRun.mockReturnValue({ getReadable, cancel: () => Promise.resolve(undefined) });

    await expect(wdkAdapter().cancel("wrun_x")).resolves.toBe(true);
  });
});
