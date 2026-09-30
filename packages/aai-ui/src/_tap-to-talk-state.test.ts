// Copyright 2026 the AAI authors. MIT license.
/**
 * The tap-to-talk statechart with no React and no session: what each tap
 * does, the three clocks, and the session going down on its own. The effects
 * are recorded in order, because the ORDER is part of the contract (the mic is
 * unmuted before the connect; a live hang-up cancels before it disconnects).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTapToTalk, type TapToTalkPhase, type TapToTalkStore } from "./_tap-to-talk-state.ts";
import type { AgentState } from "./types.ts";

const TIMING = { idleHangupMs: 3000, thinkingHangupMs: 60_000, connectTimeoutMs: 8000 };

let calls: string[];
let store: TapToTalkStore;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  store = createTapToTalk(
    {
      connect: () => calls.push("connect"),
      hangUp: () => calls.push("hangUp"),
      cancel: () => calls.push("cancel"),
      setMuted: (muted) => calls.push(muted ? "mute" : "unmute"),
    },
    () => TIMING,
  );
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

const session = (phase: TapToTalkPhase, agent: AgentState = "listening") =>
  store.send({ type: "SESSION", phase, agent });

describe("tap-to-talk statechart", () => {
  test("starts muted and not live", () => {
    expect(calls).toEqual(["mute"]);
    expect(store.getView()).toEqual({ live: false, failed: false });
  });

  test("a tap unmutes BEFORE it connects; the next cancels, hangs up and mutes", () => {
    calls = [];
    store.send({ type: "TAP" });
    expect(calls).toEqual(["unmute", "connect"]);
    expect(store.getView().live).toBe(true);
    session("connecting");
    session("active");
    calls = [];
    store.send({ type: "TAP" });
    expect(calls).toEqual(["cancel", "hangUp", "mute"]);
    expect(store.getView().live).toBe(false);
  });

  test("a call that is not live hangs up after the quiet window, and activity restarts it", () => {
    session("connecting");
    session("active");
    calls = [];
    vi.advanceTimersByTime(2000);
    session("active"); // a transcript delta, say
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(["hangUp"]);
  });

  test("thinking gets the long clock, and speaking none", () => {
    session("active", "thinking");
    calls = [];
    vi.advanceTimersByTime(59_000);
    expect(calls).toEqual([]);
    session("active", "speaking");
    vi.advanceTimersByTime(120_000);
    expect(calls).toEqual([]);
    session("active", "thinking");
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(["hangUp"]);
  });

  test("a LIVE call never hangs itself up", () => {
    store.send({ type: "TAP" });
    session("connecting");
    session("active");
    calls = [];
    vi.advanceTimersByTime(10 * 60_000);
    expect(calls).toEqual([]);
    expect(store.getView().live).toBe(true);
  });

  test("a connection that never comes fails and hangs up; the next tap clears the failure", () => {
    store.send({ type: "TAP" });
    session("connecting");
    calls = [];
    vi.advanceTimersByTime(7999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["hangUp", "mute"]);
    expect(store.getView()).toEqual({ live: false, failed: true });
    session("idle");
    store.send({ type: "TAP" });
    expect(store.getView()).toEqual({ live: true, failed: false });
  });

  test("activity while connecting does not restart the connect clock", () => {
    session("connecting");
    vi.advanceTimersByTime(5000);
    session("connecting");
    calls = [];
    vi.advanceTimersByTime(3000);
    expect(calls).toEqual(["hangUp"]);
  });

  test("the session going down on its own leaves live mode without a second hang-up", () => {
    store.send({ type: "TAP" });
    session("connecting");
    session("active");
    calls = [];
    session("idle");
    expect(calls).toEqual(["mute"]);
    expect(store.getView().live).toBe(false);
  });

  test("an error marks the attempt failed; a typed turn clears it", () => {
    store.send({ type: "ERROR" });
    expect(store.getView().failed).toBe(true);
    store.send({ type: "TEXT" });
    expect(store.getView().failed).toBe(false);
  });

  test("HANG_UP disconnects whether live or not", () => {
    session("active");
    calls = [];
    store.send({ type: "HANG_UP" });
    expect(calls).toEqual(["hangUp"]);
    store.send({ type: "TAP" });
    calls = [];
    store.send({ type: "HANG_UP" });
    expect(calls).toEqual(["hangUp", "mute"]);
  });

  test("the view is referentially stable while nothing it shows moves", () => {
    const before = store.getView();
    session("active");
    session("active", "thinking");
    expect(store.getView()).toBe(before);
  });
});
