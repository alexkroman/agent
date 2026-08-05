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
      // Default to "the utterance is over": these specs drive the window timer
      // directly. The deferral has its own describe block below.
      isUtteranceInProgress: () => false,
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

describe("createFalseInterruptionRecovery deferral while the caller is speaking", () => {
  /** Recovery whose "is the utterance still open" answer the spec controls. */
  function makeDeferrable(over: { maxConsecutive?: number } = {}) {
    const state = { speaking: true };
    const onResume = vi.fn();
    const recovery = createFalseInterruptionRecovery({
      timeoutMs: 20,
      maxConsecutive: over.maxConsecutive ?? 3,
      isActive: () => true,
      isBusy: () => false,
      isUtteranceInProgress: () => state.speaking,
      onResume,
    });
    return { recovery, onResume, state };
  }

  test("an elapsed window does not resume while the utterance is still open", async () => {
    // The case this exists for: endpointing withholds a genuine barge-in's final
    // for min_turn_silence (2000ms) after the caller stops, and the window is
    // 2000ms measured from the last partial — so the timer and the real user
    // turn arrive together. Resuming here spends a billed turn on a "false"
    // interruption that was real.
    const { recovery, onResume } = makeDeferrable();
    recovery.arm();
    await sleep(50);
    expect(onResume).not.toHaveBeenCalled();
    // Still outstanding, so continued partials keep extending rather than
    // treating the recovery as resolved.
    expect(recovery.pending()).toBe(true);
  });

  test("the utterance ending with no committed turn releases the resume", async () => {
    const { recovery, onResume, state } = makeDeferrable();
    recovery.arm();
    await sleep(50);
    expect(onResume).not.toHaveBeenCalled();

    // The speaking edge's watchdog closed it: no final is coming.
    state.speaking = false;
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(recovery.pending()).toBe(false);
  });

  test("a committed user turn discards the deferred resume", async () => {
    // The genuine-barge-in path: the final lands, so the interruption was real
    // and the reply must not be picked back up.
    const { recovery, onResume, state } = makeDeferrable();
    recovery.arm();
    await sleep(50);

    recovery.onUserTurn();
    state.speaking = false;
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();
  });

  test("clear() discards a deferred resume too", async () => {
    // A client-initiated cancel is deliberate — never resumed from, whether the
    // window fired or is still deferred.
    const { recovery, onResume, state } = makeDeferrable();
    recovery.arm();
    await sleep(50);

    recovery.clear();
    state.speaking = false;
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();
  });

  test("a released resume is counted once against the budget", async () => {
    const { recovery, onResume, state } = makeDeferrable({ maxConsecutive: 1 });
    recovery.arm();
    await sleep(50);
    state.speaking = false;
    recovery.onUtteranceEnded();
    // A second release with nothing deferred must not re-fire.
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("onUtteranceEnded is inert when no window ever fired", () => {
    const { recovery, onResume, state } = makeDeferrable();
    state.speaking = false;
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();
  });
});
