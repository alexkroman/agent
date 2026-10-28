// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { isAcknowledgementOnly } from "./acknowledgement.ts";

describe("isAcknowledgementOnly", () => {
  // Committed backchannels from Full-Duplex-Bench v1.5 (`user_backchannel`).
  test.each([
    "Mm-hmm, yeah.",
    "Uh-huh, yeah.",
    "Exactly.",
    "Yeah, right.",
    "Yes, yeah.",
    "All right.",
    "Mm-hmm.",
    "Totally.",
    "Uh-huh, sure.",
    "Um,",
    "Hmm.",
    "Got it.",
    "I see.",
  ])("%s is an acknowledgement", (text) => {
    expect(isAcknowledgementOnly(text)).toBe(true);
  });

  // Openings of committed interruptions and side remarks from the same runs:
  // none may read as an acknowledgement, or a real interruption would not cut.
  test.each([
    "Can we talk about something else?",
    "Oh, before I forget, how often should I take my dog to the vet?",
    "Hold that thought. Can we discuss cooking tips instead?",
    "Actually, can you tell me about Sculpt?",
    "Yeah, cancel that charger order",
    "Dad, microwave just quit on us.",
    "Wait, stop",
    "No.",
  ])("%s is not", (text) => {
    expect(isAcknowledgementOnly(text)).toBe(false);
  });

  test("a run of acknowledgement words past the cap is a sentence", () => {
    expect(isAcknowledgementOnly("yeah yeah right sure okay")).toBe(false);
  });

  test("nothing at all is not an acknowledgement", () => {
    expect(isAcknowledgementOnly("")).toBe(false);
    expect(isAcknowledgementOnly(" ... ")).toBe(false);
  });
});
