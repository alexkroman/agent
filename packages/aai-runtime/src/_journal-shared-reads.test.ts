// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { shareByKey } from "./_journal-shared-reads.ts";

/** A read the test settles by hand, recording every start. */
function gatedRead(): {
  read: (key: string) => Promise<string>;
  starts: string[];
  settle: (nth: number, value: string) => void;
  started: (n: number) => Promise<void>;
} {
  const starts: string[] = [];
  const pending: PromiseWithResolvers<string>[] = [];
  return {
    starts,
    read: (key: string) => {
      starts.push(key);
      const deferred = Promise.withResolvers<string>();
      pending.push(deferred);
      return deferred.promise;
    },
    // Both throw rather than assert: biome's `noMisplacedAssertion` reads an
    // `expect` outside a test body as a mistake, and a throw from a helper
    // reports against the test that called it either way.
    settle: (nth, value) => {
      const deferred = pending[nth];
      if (!deferred) throw new Error(`no read #${nth} has started`);
      deferred.resolve(value);
    },
    // A trailing read starts on the microtask chain behind the one it follows,
    // so a spec that settles it immediately settles the wrong deferred.
    started: (n) =>
      vi.waitFor(() => {
        if (starts.length < n) throw new Error(`only ${starts.length} read(s) started, want ${n}`);
      }),
  };
}

describe("shareByKey", () => {
  test("callers arriving during one read share its round trip", async () => {
    const gate = gatedRead();
    const shared = shareByKey(gate.read);

    const first = shared("run-1");
    const second = shared("run-1");
    const third = shared("run-1");
    // Only one read has started: the two that joined mid-flight are queued
    // behind the single trailing run, not behind one each.
    await gate.started(1);
    expect(gate.starts).toEqual(["run-1"]);

    gate.settle(0, "a");
    expect(await first).toBe("a");

    await gate.started(2);
    gate.settle(1, "b");
    // Three callers, TWO round trips — the whole saving.
    expect(await second).toBe("b");
    expect(await third).toBe("b");
    expect(gate.starts).toEqual(["run-1", "run-1"]);
  });

  test("nobody is answered from a read that started before they asked", async () => {
    // The property the journal's correctness rests on: `settledSince` exists to
    // see a write an earlier snapshot missed, so answering a later caller from
    // an earlier read would silently defeat it.
    const gate = gatedRead();
    const shared = shareByKey(gate.read);

    const first = shared("run-1");
    await gate.started(1);
    gate.settle(0, "before");
    expect(await first).toBe("before");

    const later = shared("run-1");
    await gate.started(2);
    gate.settle(1, "after");
    expect(await later).toBe("after");
  });

  test("different keys never share", async () => {
    const starts: string[] = [];
    const shared = shareByKey(async (key: string) => {
      starts.push(key);
      return key;
    });
    expect(await Promise.all([shared("a"), shared("b")])).toEqual(["a", "b"]);
    expect(starts.toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
  });

  test("a rejection reaches its own callers and does not wedge the key", async () => {
    let attempt = 0;
    const shared = shareByKey(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("journal unreachable");
      return "ok";
    });
    await expect(shared("run-1")).rejects.toThrow("journal unreachable");
    expect(await shared("run-1")).toBe("ok");
  });

  test("an entry is released once its last caller is answered", async () => {
    // A journal client outlives every run it serves, so an entry per run id
    // that nothing releases is an unbounded leak. Observed through the read
    // count: a released key starts fresh rather than joining a retained runner.
    const gate = gatedRead();
    const shared = shareByKey(gate.read);

    const only = shared("run-1");
    await gate.started(1);
    gate.settle(0, "a");
    expect(await only).toBe("a");

    const next = shared("run-1");
    await gate.started(2);
    expect(gate.starts).toEqual(["run-1", "run-1"]);
    gate.settle(1, "b");
    expect(await next).toBe("b");
  });
});
