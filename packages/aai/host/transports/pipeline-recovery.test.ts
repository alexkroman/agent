// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pipeline transport's false-interruption recovery: the
// recovery window timer (including its consecutive-resume budget and armed
// resume prompt) and the playback-tail resume prompt builder. Exercised
// directly rather than through the transport so the timeouts can be short and
// the timer-boundary cases stay deterministic. End-to-end wiring is covered by
// pipeline-voice-events.test.ts.

import { describe, expect, test, vi } from "vitest";
import { DEFAULT_FALSE_INTERRUPTION_PROMPT } from "../../sdk/constants.ts";
import { buildTailResumePrompt, createFalseInterruptionRecovery } from "./pipeline-recovery.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createFalseInterruptionRecovery", () => {
  function makeRecovery(over: Partial<Parameters<typeof createFalseInterruptionRecovery>[0]> = {}) {
    const onResume = vi.fn();
    const recovery = createFalseInterruptionRecovery({
      timeoutMs: 20,
      maxConsecutive: 3,
      isActive: () => true,
      isBusy: () => false,
      onResume,
      ...over,
    });
    return { recovery, onResume };
  }

  test("resumes once the window elapses", async () => {
    const { recovery, onResume } = makeRecovery();
    recovery.arm();
    expect(recovery.pending()).toBe(true);
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });
    expect(recovery.pending()).toBe(false);
  });

  test("timeoutMs 0 disables recovery entirely", async () => {
    const { recovery, onResume } = makeRecovery({ timeoutMs: 0 });
    recovery.arm();
    expect(recovery.pending()).toBe(false);
    await sleep(40);
    expect(onResume).not.toHaveBeenCalled();
  });

  test("re-arming pushes the deadline out so a still-talking user isn't spoken over", async () => {
    const { recovery, onResume } = makeRecovery({ timeoutMs: 50 });
    recovery.arm();
    // Each "partial" re-arms while the window is pending.
    for (let i = 0; i < 4; i++) {
      await sleep(25);
      expect(recovery.pending()).toBe(true);
      recovery.arm();
    }
    // Total elapsed (~100 ms) is well past one window, but none elapsed fully.
    expect(onResume).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });
  });

  test("clear cancels a pending window but keeps the budget", async () => {
    const { recovery, onResume } = makeRecovery();
    recovery.arm();
    recovery.clear();
    expect(recovery.pending()).toBe(false);
    await sleep(40);
    expect(onResume).not.toHaveBeenCalled();

    // Budget untouched: a later barge-in can still recover.
    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });
  });

  test("caps consecutive resumes so cross-talk cannot loop forever", async () => {
    const { recovery, onResume } = makeRecovery({ maxConsecutive: 3 });

    // Simulate persistent noise: every resume is followed by another barge-in
    // that never commits a user turn.
    for (let i = 0; i < 6; i++) {
      recovery.arm();
      await sleep(40);
    }
    expect(onResume).toHaveBeenCalledTimes(3);
    // Budget spent — arming is now inert.
    expect(recovery.pending()).toBe(false);
  });

  test("a committed user turn restores the budget", async () => {
    const { recovery, onResume } = makeRecovery({ maxConsecutive: 1 });

    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(1);
    });

    // Spent: no further resume.
    recovery.arm();
    await sleep(40);
    expect(onResume).toHaveBeenCalledTimes(1);

    // The user speaks for real → budget restored.
    recovery.onUserTurn();
    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledTimes(2);
    });
  });

  test("fires with the prompt it was armed with; a bare re-arm keeps it", async () => {
    const { recovery, onResume } = makeRecovery({ timeoutMs: 20 });

    recovery.arm('cut at: "…ice and ember"');
    // Deadline-extension re-arm (continued partials) carries no prompt and
    // must not clobber the barge-in's.
    recovery.arm();
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledWith('cut at: "…ice and ember"');
    });

    // The next barge-in's arm replaces the stored prompt.
    recovery.arm(DEFAULT_FALSE_INTERRUPTION_PROMPT);
    await vi.waitFor(() => {
      expect(onResume).toHaveBeenCalledWith(DEFAULT_FALSE_INTERRUPTION_PROMPT);
    });
  });

  test("a fired window is dropped when the transport went inactive or busy", async () => {
    const inactive = makeRecovery({ isActive: () => false });
    inactive.recovery.arm();
    await sleep(40);
    expect(inactive.onResume).not.toHaveBeenCalled();

    const busy = makeRecovery({ isBusy: () => true });
    busy.recovery.arm();
    await sleep(40);
    expect(busy.onResume).not.toHaveBeenCalled();
  });
});

describe("buildTailResumePrompt", () => {
  const spoken =
    "You place the locket in their palm. Their fingers brush yours - ice and ember - " +
    "and the locket shatters into smoke. She whispers. Then she is gone.";

  test("quotes the last heard words, snapped back to a word boundary", () => {
    // Half-heard: the cut estimate lands mid-word, so the anchor must end at
    // the word boundary before it and quote what precedes it.
    const prompt = buildTailResumePrompt(spoken, 0.5);
    const anchor = prompt.match(/"…(.*)"/)?.[1] ?? "";
    expect(anchor.length).toBeGreaterThan(0);
    // The anchor is verbatim heard text and never splits a word.
    expect(spoken).toContain(anchor);
    expect(spoken.slice(0, spoken.indexOf(anchor) + anchor.length)).toMatch(/\S$/);
    expect(prompt).toContain("without repeating what they already heard");
  });

  test("caps the anchor length", () => {
    const long = `${"word ".repeat(200)}end.`;
    const prompt = buildTailResumePrompt(long, 1);
    const anchor = prompt.match(/"…(.*)"/)?.[1] ?? "";
    expect(anchor.length).toBeLessThanOrEqual(80);
  });

  test("a caller who heard nothing is asked for the reply again, not an empty anchor", () => {
    const prompt = buildTailResumePrompt(spoken, 0);
    expect(prompt).not.toContain('"…');
    expect(prompt).toContain("Give that reply again");
  });

  test("clamps an out-of-range fraction", () => {
    expect(() => buildTailResumePrompt(spoken, 1.7)).not.toThrow();
    expect(buildTailResumePrompt(spoken, -0.3)).toContain("Give that reply again");
  });
});
