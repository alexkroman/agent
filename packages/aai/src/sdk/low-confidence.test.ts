// Copyright 2026 the AAI authors. MIT license.
/**
 * The three bands, the defaults they open at, and the one rule that decides
 * whether this policy is safe to leave on: a provider with NO opinion is
 * accepted rather than treated as a zero.
 */

import { describe, expect, test } from "vitest";
import {
  classifyConfidence,
  DEFAULT_LOW_CONFIDENCE_ACTION_BELOW,
  DEFAULT_LOW_CONFIDENCE_DISCARD_BELOW,
  DEFAULT_LOW_CONFIDENCE_NOTE,
  DEFAULT_LOW_CONFIDENCE_PHRASE,
  resolveLowConfidence,
} from "./low-confidence.ts";

describe("resolveLowConfidence", () => {
  test("an empty policy is the documented defaults", () => {
    expect(resolveLowConfidence({})).toEqual({
      discardBelow: 0.2,
      actionBelow: 0.4,
      action: "clarify",
      phrase: DEFAULT_LOW_CONFIDENCE_PHRASE,
      note: DEFAULT_LOW_CONFIDENCE_NOTE,
      statistic: "mean",
    });
    // Pinned against the constants too: these two numbers are Vapi's published
    // pair, and a change to either is a behaviour change for every agent that
    // opted in at the defaults.
    expect([DEFAULT_LOW_CONFIDENCE_DISCARD_BELOW, DEFAULT_LOW_CONFIDENCE_ACTION_BELOW]).toEqual([
      0.2, 0.4,
    ]);
  });

  test("each field overrides independently", () => {
    const resolved = resolveLowConfidence({ actionBelow: 0.6, statistic: "minWord" });
    expect(resolved.actionBelow).toBe(0.6);
    expect(resolved.statistic).toBe("minWord");
    expect(resolved.discardBelow).toBe(0.2);
  });

  test("an empty phrase SURVIVES the default", () => {
    // `?? `, not `||`: "" is how an author says "drop it and say nothing",
    // which is a third behaviour and not a request for the default sentence.
    expect(resolveLowConfidence({ phrase: "" }).phrase).toBe("");
  });
});

describe("classifyConfidence", () => {
  const policy = resolveLowConfidence({});

  test("a provider that reported nothing is ACCEPTED", () => {
    // The rule the whole policy rests on. Three of four STT providers report
    // no per-word confidence at all, and reading that as 0 would discard every
    // turn they ever transcribe.
    expect(classifyConfidence(undefined, policy)).toEqual({ kind: "accept" });
    expect(classifyConfidence(Number.NaN, policy)).toEqual({ kind: "accept" });
  });

  test("below the floor is discarded", () => {
    expect(classifyConfidence(0.19, policy)).toEqual({ kind: "discard", confidence: 0.19 });
  });

  test("the band between the two thresholds clarifies", () => {
    expect(classifyConfidence(0.3, policy)).toEqual({
      kind: "clarify",
      confidence: 0.3,
      phrase: DEFAULT_LOW_CONFIDENCE_PHRASE,
    });
  });

  test("at or above the action threshold is accepted", () => {
    expect(classifyConfidence(0.4, policy)).toEqual({ kind: "accept" });
    expect(classifyConfidence(0.99, policy)).toEqual({ kind: "accept" });
  });

  test("the floor is inclusive at its lower edge", () => {
    // 0.2 exactly is IN the band, not discarded: `<` on the floor and `>=` on
    // the ceiling is what makes the three bands contiguous and non-overlapping.
    expect(classifyConfidence(0.2, policy).kind).toBe("clarify");
  });

  test("`note` returns the note instead of speaking", () => {
    const noting = resolveLowConfidence({ action: "note", note: "check the id" });
    expect(classifyConfidence(0.25, noting)).toEqual({
      kind: "note",
      confidence: 0.25,
      note: "check the id",
    });
  });

  test("equal thresholds leave NO action band rather than an inverted one", () => {
    const floorOnly = resolveLowConfidence({ discardBelow: 0.3, actionBelow: 0.3 });
    expect(classifyConfidence(0.29, floorOnly).kind).toBe("discard");
    expect(classifyConfidence(0.3, floorOnly).kind).toBe("accept");
  });
});
