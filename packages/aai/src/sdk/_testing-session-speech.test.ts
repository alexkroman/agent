// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { recordingSpeech } from "./_testing-session-speech.ts";

describe("recordingSpeech", () => {
  test("records each say with its interrupt flag, in order, and settles it PLAYED", async () => {
    const { speech, said } = recordingSpeech();
    const first = speech.say("One.");
    speech.say("Two.", { interrupt: true });
    await expect(first.done).resolves.toBe("played");
    expect(said).toEqual([
      { text: "One.", interrupt: false },
      { text: "Two.", interrupt: true },
    ]);
  });

  test("counts interrupts, and each recorder counts its own", () => {
    const a = recordingSpeech();
    const b = recordingSpeech();
    expect(a.speech.interrupt()).toBe(true);
    a.speech.interrupt();
    expect(a.interrupts()).toBe(2);
    expect(b.interrupts()).toBe(0);
  });
});
