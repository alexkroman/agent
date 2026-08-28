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
const getRun = vi.fn((_runId: string) => ({ getReadable }));

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
}));
vi.mock("workflow/runtime", () => ({ getWorld: vi.fn() }));

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
