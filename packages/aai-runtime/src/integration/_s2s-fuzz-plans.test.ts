// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S fuzz's two command plans differ in exactly one thing: only the
 * retirement plan may draw a FATAL command, which is what lets the live-session
 * property assert the session never dies.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { liveSessionCommands, retirementCommands } from "./_s2s-fuzz-plans.ts";

/** Every command label a plan drew across a fixed-seed sample. */
function labelsDrawn(plan: ReturnType<typeof liveSessionCommands>): Set<string> {
  const labels = new Set<string>();
  for (const commands of fc.sample(plan, { numRuns: 200, seed: 42 })) {
    for (const cmd of commands) labels.add(String(cmd));
  }
  return labels;
}

const FATAL = ["drop.fatal(1008)", "drop.fatal(4001)", "session.error(session_not_found)"];

describe("liveSessionCommands", () => {
  test("never draws a fatal command", () => {
    const labels = labelsDrawn(liveSessionCommands());
    for (const label of FATAL.slice(0, 2)) expect(labels).not.toContain(label);
    expect(labels).toContain("tool.call");
    expect(labels).toContain("drop.transient(1006)");
  });
});

describe("retirementCommands", () => {
  test("can draw the fatal commands the live plan withholds", () => {
    const labels = labelsDrawn(retirementCommands());
    for (const label of FATAL) expect(labels).toContain(label);
  });
});
