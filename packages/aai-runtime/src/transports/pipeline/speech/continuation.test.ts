// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  CONTINUATION_BURST_MS,
  createContinuationGate,
  MAX_CONTINUATIONS,
} from "./continuation.ts";

function gate(windowMs = 2500) {
  let t = 10_000;
  const g = createContinuationGate({ windowMs: () => windowMs, now: () => t });
  return {
    g,
    at: (ms: number) => {
      t = ms;
    },
  };
}

describe("createContinuationGate", () => {
  test("speech opening within the window after a commit continues that turn", () => {
    const { g, at } = gate();
    at(10_000);
    g.onCommit();
    expect(g.continues(11_900)).toBe(true);
  });

  test("speech opening after the window is a new turn", () => {
    const { g } = gate();
    g.onCommit();
    expect(g.continues(10_000 + 2501)).toBe(false);
  });

  test("fires at most once per utterance", () => {
    const { g } = gate();
    g.onCommit();
    expect(g.continues(11_000)).toBe(true);
    expect(g.continues(11_000)).toBe(false);
  });

  test("an utterance that opened before the commit is the one that committed", () => {
    const { g } = gate();
    g.onCommit();
    expect(g.continues(9500)).toBe(false);
  });

  test("nothing continues before any turn has committed", () => {
    const { g } = gate();
    expect(g.continues(10_500)).toBe(false);
  });

  test("a window of 0 disables it", () => {
    const { g } = gate(0);
    g.onCommit();
    expect(g.continues(10_000)).toBe(false);
  });

  test("a later commit restarts the window and re-arms the latch", () => {
    const { g, at } = gate();
    g.onCommit();
    expect(g.continues(11_000)).toBe(true);
    at(20_000);
    g.onCommit();
    expect(g.continues(11_000)).toBe(false);
    expect(g.continues(21_000)).toBe(true);
  });

  test("caps continuations per burst, so re-prompting cannot starve the reply", () => {
    const { g, at } = gate();
    let t = 10_000;
    let fired = 0;
    for (let i = 0; i < MAX_CONTINUATIONS + 2; i++) {
      at(t);
      g.onCommit();
      if (g.continues(t + 500)) fired += 1;
      t += 2000;
    }
    expect(fired).toBe(MAX_CONTINUATIONS);
    // Once the burst has passed, it may fire again.
    t += CONTINUATION_BURST_MS;
    at(t);
    g.onCommit();
    expect(g.continues(t + 500)).toBe(true);
  });
});
