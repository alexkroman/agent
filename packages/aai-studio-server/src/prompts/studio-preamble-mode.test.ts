// Copyright 2026 the AAI authors. MIT license.
// The mode-dependent fragments of the studio preamble
// (studio-preamble-mode.ts). How they compose into a prompt is
// studio-preamble.test.ts and studio-prompt.test.ts.

import { describe, expect, test } from "vitest";
import { PROJECT_KINDS } from "../studio-project-kind.ts";
import { PREAMBLE_MODES } from "./studio-preamble-mode.ts";

const FRAGMENTS = ["overview", "productShape", "spokenReplies", "clientUi", "alignment"] as const;

describe("PREAMBLE_MODES", () => {
  test("has a fragment set for every project kind", () => {
    expect(Object.keys(PREAMBLE_MODES).sort()).toEqual([...PROJECT_KINDS].sort());
  });

  // A swap, not a shared default: each of the five is text that is WRONG for
  // the other mode, so two kinds sharing one would make the switcher a no-op
  // for that section.
  test.each(FRAGMENTS)("the %s fragment differs between the kinds", (fragment) => {
    expect(PREAMBLE_MODES.agent[fragment].trim()).not.toBe("");
    expect(PREAMBLE_MODES.workflow[fragment].trim()).not.toBe("");
    expect(PREAMBLE_MODES.agent[fragment]).not.toBe(PREAMBLE_MODES.workflow[fragment]);
  });

  test("each kind's product shape defaults to its own front door", () => {
    expect(PREAMBLE_MODES.agent.productShape).toContain("Default to a VOICE agent");
    expect(PREAMBLE_MODES.workflow.productShape).toContain("Default to a STATIC workflow app");
    expect(PREAMBLE_MODES.workflow.productShape).not.toContain("Default to a VOICE agent");
  });

  test("only the agent mode says replies are spoken", () => {
    expect(PREAMBLE_MODES.agent.spokenReplies).toContain("Replies are spoken aloud");
    expect(PREAMBLE_MODES.workflow.spokenReplies).toContain("Nothing here is spoken");
  });
});
