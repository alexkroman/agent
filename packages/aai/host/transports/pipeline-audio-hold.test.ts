// Copyright 2026 the AAI authors. MIT license.
// Specs for the provisional audio hold — the "go quiet now, decide later"
// half of pipeline barge-in. See createAudioHold.

import { describe, expect, test, vi } from "vitest";
import { sleep } from "../_test-utils.ts";
import { createAudioHold } from "./pipeline-audio-hold.ts";

const pcm = (n: number): Int16Array => new Int16Array(n);

function makeHold(maxHoldMs = 1000) {
  const backstopped: Int16Array[][] = [];
  const hold = createAudioHold({
    maxHoldMs,
    onBackstopRelease: (chunks) => backstopped.push(chunks),
  });
  return { hold, backstopped };
}

describe("createAudioHold", () => {
  test("passes audio straight through when not held", () => {
    const { hold } = makeHold();
    const a = pcm(1);
    expect(hold.push(a)).toEqual([a]);
    expect(hold.held()).toBe(false);
  });

  test("withholds while held and releases in order", () => {
    const { hold } = makeHold();
    const [a, b] = [pcm(1), pcm(2)];
    hold.hold();
    expect(hold.push(a)).toEqual([]);
    expect(hold.push(b)).toEqual([]);
    expect(hold.held()).toBe(true);
    // Order matters: this is speech. Releasing it shuffled would be worse than
    // dropping it.
    expect(hold.release()).toEqual([a, b]);
    expect(hold.held()).toBe(false);
  });

  test("discard drops held audio and reopens the gate", () => {
    const { hold } = makeHold();
    hold.hold();
    hold.push(pcm(1));
    hold.discard();
    expect(hold.held()).toBe(false);
    // Nothing is retained: a real barge-in means the caller must not hear the
    // rest of the sentence later.
    expect(hold.release()).toEqual([]);
    const c = pcm(3);
    expect(hold.push(c)).toEqual([c]);
  });

  test("release after discard yields nothing (double-resolve is safe)", () => {
    // Both resolve paths can race — a final commits while the idle watchdog
    // fires. Whichever lands second must not resurrect dropped audio.
    const { hold } = makeHold();
    hold.hold();
    hold.push(pcm(1));
    hold.discard();
    expect(hold.release()).toEqual([]);
  });

  test("the backstop releases a hold nobody resolved", async () => {
    // THE failure mode this design must not have: a hold whose resolving event
    // never arrives is a permanently mute agent. Releasing is the safe
    // direction — the worst case is the pre-existing behaviour of talking over
    // the caller.
    const { hold, backstopped } = makeHold(20);
    const a = pcm(1);
    hold.hold();
    hold.push(a);
    await vi.waitFor(() => expect(backstopped).toHaveLength(1));
    expect(backstopped[0]).toEqual([a]);
    expect(hold.held()).toBe(false);
    const b = pcm(2);
    expect(hold.push(b)).toEqual([b]);
  });

  test("a resolved hold never fires the backstop afterwards", async () => {
    const { hold, backstopped } = makeHold(20);
    hold.hold();
    hold.push(pcm(1));
    hold.release();
    await sleep(50);
    expect(backstopped).toEqual([]);
  });

  test("repeated holds do NOT extend the window — it runs from the first word", async () => {
    // The deadlock this prevents: while the agent is quiet the caller keeps
    // talking ("Are you still there?"), every partial calls hold() again, and a
    // re-arming timer never fires — so the audio is never released, which makes
    // them talk more. Shipped once; the agent went mute mid-word and the caller
    // hung up after 35s.
    const { hold, backstopped } = makeHold(40);
    const a = pcm(1);
    hold.hold();
    hold.push(a);
    const keepTalking = setInterval(() => hold.hold(), 5);
    try {
      await vi.waitFor(() => expect(backstopped).toHaveLength(1));
    } finally {
      clearInterval(keepTalking);
    }
    expect(backstopped[0]).toEqual([a]);
  });
});
