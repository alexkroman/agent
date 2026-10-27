// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { CALLER_STOP_FRESH_MS, createCallerStop } from "./caller-stop.ts";

describe("createCallerStop", () => {
  test("the caller stopped trailingSilenceMs before the commit", () => {
    let t = 10_000;
    const stop = createCallerStop(() => t);
    stop.onCommit(1800);
    t += 50;
    expect(stop.stoppedAt()).toBe(8200);
  });

  test("nothing before any commit, or for a commit without timing", () => {
    const stop = createCallerStop(() => 5000);
    expect(stop.stoppedAt()).toBeUndefined();
    stop.onCommit(undefined);
    expect(stop.stoppedAt()).toBeUndefined();
  });

  // A chained turn opens once the reply in flight has finished: its opening
  // gap follows the agent's speech, not the caller's.
  test("a turn opening long after the commit does not anchor on it", () => {
    let t = 0;
    const stop = createCallerStop(() => t);
    stop.onCommit(900);
    t = CALLER_STOP_FRESH_MS + 1;
    expect(stop.stoppedAt()).toBeUndefined();
  });

  test("the latest commit wins, and a negative silence reads as none", () => {
    let t = 1000;
    const stop = createCallerStop(() => t);
    stop.onCommit(500);
    t = 3000;
    stop.onCommit(-20);
    expect(stop.stoppedAt()).toBe(3000);
  });
});
