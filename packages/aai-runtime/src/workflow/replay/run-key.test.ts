// Copyright 2026 the AAI authors. MIT license.
/**
 * The run key as a journal entry: minted by `start`, read and REACHED by the
 * walk, and absent for a run that never had one.
 */

import { describe, expect, test } from "vitest";
import { watchDivergence } from "./divergence.ts";
import { RUN_KEY_STEP, readRunKey, runKeyEntry } from "./run-key.ts";

describe("runKeyEntry", () => {
  test("is an `ok` entry in the `!` key space, charged no attempt", () => {
    expect(runKeyEntry("sess-1", 5)).toEqual({
      key: "key!",
      name: "key",
      status: "ok",
      output: "sess-1",
      attempts: 0,
      startedAt: 5,
      finishedAt: 5,
    });
    // Not producible by `${name}#${occurrence}`, so no author step aliases it.
    expect(RUN_KEY_STEP).not.toMatch(/#/);
  });
});

describe("readRunKey", () => {
  test("answers the journaled key and REACHES it, so the next step is not refused", () => {
    const entry = runKeyEntry("sess-1", 1);
    const settled = new Map([[entry.key, entry]]);
    const divergence = watchDivergence([entry]);
    expect(readRunKey(settled, divergence)).toBe("sess-1");
    // A fresh key reached afterwards is ordinary new work: the one journaled
    // entry has been explained.
    expect(divergence.reach("research#0", "research", undefined)).toBeUndefined();
  });

  test("an unreached key entry WOULD refuse the next step — the reach is load-bearing", () => {
    const entry = runKeyEntry("sess-1", 1);
    const divergence = watchDivergence([entry]);
    expect(divergence.reach("research#0", "research", undefined)).toBeDefined();
  });

  test("a run with no entry reads `undefined`", () => {
    expect(readRunKey(new Map(), watchDivergence([]))).toBeUndefined();
  });
});
