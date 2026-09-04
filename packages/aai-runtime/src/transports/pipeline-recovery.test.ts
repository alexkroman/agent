// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pipeline transport's false-interruption recovery: the
// resume latch (including its consecutive-resume budget and armed resume
// prompt) and the playback-tail resume prompt builder. Exercised directly
// rather than through the transport, so the latch's release is driven by hand
// instead of by a real speaking-edge watchdog. End-to-end wiring is covered by
// pipeline-voice-events.test.ts, and the invariant that every path closing the
// speaking edge consumes or clears the latch by pipeline-user-speech.test.ts.

import { DEFAULT_FALSE_INTERRUPTION_PROMPT } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { buildTailResumePrompt, createFalseInterruptionRecovery } from "./pipeline-recovery.ts";

const PROMPT = DEFAULT_FALSE_INTERRUPTION_PROMPT;

describe("createFalseInterruptionRecovery", () => {
  function makeRecovery(over: Partial<Parameters<typeof createFalseInterruptionRecovery>[0]> = {}) {
    const onResume = vi.fn();
    const recovery = createFalseInterruptionRecovery({
      enabled: true,
      maxConsecutive: 3,
      isActive: () => true,
      isBusy: () => false,
      onResume,
      ...over,
    });
    return { recovery, onResume };
  }

  test("resumes when the utterance ends with no committed turn", () => {
    // The whole mechanism in one line: the transcript stream went quiet and no
    // final ever came, which is the only signal proving the interruption was
    // noise. There is no timer — the speaking edge's idle watchdog calls this.
    const { recovery, onResume } = makeRecovery();
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("onUtteranceEnded is inert when nothing is armed", () => {
    const { recovery, onResume } = makeRecovery();
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();
  });

  test("a released latch is consumed once", () => {
    const { recovery, onResume } = makeRecovery();
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    // A later utterance going idle must not re-fire the same recovery.
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("enabled false arms nothing", () => {
    const { recovery, onResume } = makeRecovery({ enabled: false });
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();
  });

  test("clear() discards an armed latch but keeps the budget", () => {
    // A client-initiated cancel is deliberate — never resumed from.
    const { recovery, onResume } = makeRecovery();
    recovery.arm(PROMPT);
    recovery.clear();
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();

    // Budget untouched: a later barge-in can still recover.
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("a committed user turn discards the latch and restores the budget", () => {
    // The genuine-barge-in path: the final lands, so the interruption was real
    // and the reply must not be picked back up.
    const { recovery, onResume } = makeRecovery({ maxConsecutive: 1 });
    recovery.arm(PROMPT);
    recovery.onUserTurn();
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();

    // Spend the budget, then prove a committed turn refills it.
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(1);

    recovery.onUserTurn();
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  test("caps consecutive resumes so cross-talk cannot loop forever", () => {
    const { recovery, onResume } = makeRecovery({ maxConsecutive: 3 });
    // Persistent noise: every resume is followed by another barge-in that
    // never commits a user turn.
    for (let i = 0; i < 6; i++) {
      recovery.arm(PROMPT);
      recovery.onUtteranceEnded();
    }
    expect(onResume).toHaveBeenCalledTimes(3);
  });

  test("a release is dropped when the transport went inactive or busy", () => {
    const inactive = makeRecovery({ isActive: () => false });
    inactive.recovery.arm(PROMPT);
    inactive.recovery.onUtteranceEnded();
    expect(inactive.onResume).not.toHaveBeenCalled();

    const busy = makeRecovery({ isBusy: () => true });
    busy.recovery.arm(PROMPT);
    busy.recovery.onUtteranceEnded();
    expect(busy.onResume).not.toHaveBeenCalled();
  });

  test("a dropped release does not linger into the next utterance", () => {
    // Something else took the floor, so this interruption resolved itself. The
    // latch must not survive to fire against a later, unrelated utterance.
    const state = { busy: true };
    const { recovery, onResume } = makeRecovery({ isBusy: () => state.busy });
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    state.busy = false;
    recovery.onUtteranceEnded();
    expect(onResume).not.toHaveBeenCalled();
  });

  test("fires with the prompt it was armed with", () => {
    const { recovery, onResume } = makeRecovery();
    recovery.arm('cut at: "…ice and ember"');
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenCalledWith('cut at: "…ice and ember"');

    // The next barge-in's arm replaces the stored prompt.
    recovery.arm(PROMPT);
    recovery.onUtteranceEnded();
    expect(onResume).toHaveBeenLastCalledWith(PROMPT);
  });
});

describe("buildTailResumePrompt", () => {
  const spoken =
    "You place the locket in their palm. Their fingers brush yours - ice and ember - " +
    "and the locket shatters into smoke. She whispers. Then she is gone.";

  test("quotes the last heard words", () => {
    // The heard cursor (pipeline-heard.ts) already snapped this to a word
    // boundary; this function only takes the anchor off the end of it.
    const heard = spoken.slice(0, spoken.indexOf("smoke"));
    const prompt = buildTailResumePrompt(heard);
    const anchor = prompt.match(/"…(.*)"/)?.[1] ?? "";
    expect(anchor.length).toBeGreaterThan(0);
    // The anchor is verbatim heard text, and a SUFFIX of it — the two-readers,
    // one-cursor invariant: history records `heard`, so the prompt can only
    // quote words the record also has.
    expect(heard.trimEnd().endsWith(anchor)).toBe(true);
    expect(prompt).toContain("without repeating what they already heard");
  });

  test("caps the anchor length", () => {
    const long = `${"word ".repeat(200)}end.`;
    const prompt = buildTailResumePrompt(long);
    const anchor = prompt.match(/"…(.*)"/)?.[1] ?? "";
    expect(anchor.length).toBeLessThanOrEqual(80);
  });

  test("a caller who heard nothing is asked for the reply again, not an empty anchor", () => {
    const prompt = buildTailResumePrompt("");
    expect(prompt).not.toContain('"…');
    expect(prompt).toContain("Give that reply again");
  });

  test("whitespace-only heard text is the nothing-heard case", () => {
    expect(buildTailResumePrompt("   ")).toContain("Give that reply again");
  });
});
