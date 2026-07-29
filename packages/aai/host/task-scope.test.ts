// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { flush } from "./_test-utils.ts";
import { createTaskScope } from "./task-scope.ts";

describe("createTaskScope — awaitable interrupt", () => {
  test("interrupt() resolves only after the work settled and finalizers ran", async () => {
    const scope = createTaskScope();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();

    const work = scope.run(async () => {
      scope.onInterrupt(async () => {
        await flush();
        order.push("finalizer");
      });
      await gate.promise;
      order.push("work-settled");
    });

    const interrupted = scope.interrupt().then(() => order.push("interrupt-resolved"));
    expect(scope.signal.aborted).toBe(true);
    gate.resolve();
    await Promise.all([work, interrupted]);
    expect(order).toEqual(["work-settled", "finalizer", "interrupt-resolved"]);
  });

  test("finalizers never run when the work completes without interruption", async () => {
    const scope = createTaskScope();
    const finalizer = vi.fn();
    await scope.run(async () => {
      scope.onInterrupt(finalizer);
    });
    expect(finalizer).not.toHaveBeenCalled();
  });

  test("discardFinalizers skips pending finalizers", async () => {
    const scope = createTaskScope();
    const finalizer = vi.fn();
    const gate = Promise.withResolvers<void>();
    const work = scope.run(async () => {
      scope.onInterrupt(finalizer);
      await gate.promise;
    });
    const interrupted = scope.interrupt({ discardFinalizers: true });
    gate.resolve();
    await Promise.all([work, interrupted]);
    expect(finalizer).not.toHaveBeenCalled();
  });

  test("a discard after a plain interrupt still cancels not-yet-run finalizers", async () => {
    // The cancelReply-then-reset window: the first interrupt would persist,
    // but reset() arrives before the work settles and must discard.
    const scope = createTaskScope();
    const finalizer = vi.fn();
    const gate = Promise.withResolvers<void>();
    const work = scope.run(async () => {
      scope.onInterrupt(finalizer);
      await gate.promise;
    });
    const first = scope.interrupt();
    const second = scope.interrupt({ discardFinalizers: true });
    gate.resolve();
    await Promise.all([work, first, second]);
    expect(finalizer).not.toHaveBeenCalled();
  });

  test("finalizers run in order; a throw is contained and the rest still run", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const scope = createTaskScope();
      const order: string[] = [];
      const work = scope.run(async () => {
        scope.onInterrupt(() => {
          order.push("first");
          throw new Error("boom");
        });
        scope.onInterrupt(() => {
          order.push("second");
        });
      });
      // Abort before the (instant) work settles is racy from out here; abort
      // first, then run — aborted-at-settle is what triggers finalizers.
      await scope.interrupt();
      await work;
      expect(order).toEqual(["first", "second"]);
      expect(errSpy).toHaveBeenCalledWith(
        "[task-scope] interrupt finalizer threw",
        expect.any(Error),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  test("the work's rejection passes through and the scope still settles", async () => {
    const scope = createTaskScope();
    await expect(
      scope.run(async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    await expect(scope.interrupt()).resolves.toBeUndefined();
  });

  test("interrupt before run() resolves immediately", async () => {
    const scope = createTaskScope();
    await expect(scope.interrupt()).resolves.toBeUndefined();
    expect(scope.signal.aborted).toBe(true);
  });

  test("run() is single-use", async () => {
    const scope = createTaskScope();
    await scope.run(async () => undefined);
    await expect(scope.run(async () => undefined)).rejects.toThrow("only be called once");
  });
});

describe("createTaskScope — parent linking (replaces linkAbort)", () => {
  test("parent abort interrupts the scope", async () => {
    const parent = new AbortController();
    const scope = createTaskScope({ parent: parent.signal });
    parent.abort();
    expect(scope.signal.aborted).toBe(true);
  });

  test("an already-aborted parent yields an aborted scope", () => {
    const parent = new AbortController();
    parent.abort();
    const scope = createTaskScope({ parent: parent.signal });
    expect(scope.signal.aborted).toBe(true);
  });

  test("the parent link is removed at settle", async () => {
    const parent = new AbortController();
    const scope = createTaskScope({ parent: parent.signal });
    await scope.run(async () => undefined);
    parent.abort();
    expect(scope.signal.aborted).toBe(false);
  });
});

describe("createTaskScope — scope-owned timers", () => {
  test("an armed timer fires while the scope is live", async () => {
    vi.useFakeTimers();
    try {
      const scope = createTaskScope();
      const fired = vi.fn();
      scope.timer(fired).arm(50);
      vi.advanceTimersByTime(50);
      expect(fired).toHaveBeenCalledTimes(1);
      await scope.interrupt();
    } finally {
      vi.useRealTimers();
    }
  });

  test("interrupt clears armed timers immediately — they never fire", async () => {
    vi.useFakeTimers();
    try {
      const scope = createTaskScope();
      const fired = vi.fn();
      const gate = Promise.withResolvers<void>();
      const work = scope.run(async () => {
        scope.timer(fired).arm(50);
        await gate.promise;
      });
      const interrupted = scope.interrupt();
      vi.advanceTimersByTime(200);
      expect(fired).not.toHaveBeenCalled();
      gate.resolve();
      await Promise.all([work, interrupted]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("settle clears armed timers — a turn's timer cannot fire after it", async () => {
    vi.useFakeTimers();
    try {
      const scope = createTaskScope();
      const fired = vi.fn();
      await scope.run(async () => {
        scope.timer(fired).arm(50);
      });
      vi.advanceTimersByTime(200);
      expect(fired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a timer requested after the scope is over is inert", async () => {
    vi.useFakeTimers();
    try {
      const scope = createTaskScope();
      await scope.interrupt();
      const fired = vi.fn();
      const t = scope.timer(fired);
      t.arm(10);
      expect(t.pending()).toBe(false);
      vi.advanceTimersByTime(100);
      expect(fired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
