// Copyright 2026 the AAI authors. MIT license.
/**
 * What is worth asserting about a label map is not the words — a spec that
 * restates them is a second copy of the file — but the two properties a chrome
 * relies on: that it is TOTAL over the union (a page spreading it cannot end up
 * without a key, which is what each hand-rolled ternary chain's `: "Idle"` tail
 * silently did), and that spreading it to override one member leaves the rest
 * intact.
 */

import { describe, expect, test } from "vitest";
import { AGENT_STATE_LABELS } from "./agent-state-labels.ts";
import type { AgentState } from "./types.ts";

// Written out rather than derived from the map under test: deriving the
// expected keys from the actual keys is the vacuous version of this assertion,
// and `AgentState` is a type, so nothing at runtime can enumerate it for us.
// A member added to the union makes the `satisfies` below a compile error here
// and the `Record` a compile error in the source — which is the whole point of
// the map being a `Record` rather than a `switch`.
const EVERY_STATE = [
  "disconnected",
  "connecting",
  "ready",
  "listening",
  "thinking",
  "speaking",
  "error",
] as const satisfies readonly AgentState[];

describe("AGENT_STATE_LABELS", () => {
  test("covers every AgentState, with a non-empty label and no leftover enum member", () => {
    for (const state of EVERY_STATE) {
      const label = AGENT_STATE_LABELS[state];
      expect(label, state).toBeTypeOf("string");
      expect(label.length, state).toBeGreaterThan(0);
      // The failure being guarded is `retail`'s: a chrome rendering the raw
      // wire member, so a caller reads a lowercase `disconnected` in the header.
      expect(label, state).not.toBe(state);
    }
    expect(Object.keys(AGENT_STATE_LABELS).toSorted()).toEqual([...EVERY_STATE].toSorted());
  });

  test("an override by spread replaces one key and keeps the other six", () => {
    // The documented way a page renames a state. A `Record` cannot lose a key
    // this way; a `switch` per page could, and did.
    const labels = { ...AGENT_STATE_LABELS, thinking: "Processing" };
    expect(labels.thinking).toBe("Processing");
    expect(labels.listening).toBe(AGENT_STATE_LABELS.listening);
    expect(Object.keys(labels)).toHaveLength(EVERY_STATE.length);
  });

  test("is sentence case, so a chrome that shouts can and one that does not need not", () => {
    // Shipping the shouted form would leave the two chromes that do not shout
    // with a string no case transform un-shouts correctly.
    for (const state of EVERY_STATE) {
      const label = AGENT_STATE_LABELS[state];
      expect(label, state).not.toBe(label.toUpperCase());
    }
  });
});
