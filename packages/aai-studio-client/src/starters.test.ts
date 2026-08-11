// Copyright 2026 the AAI authors. MIT license.
// The hero shows a random sample of one KIND's starter catalog, not all of it —
// these pin the sample's size, uniqueness, provenance, and which pool it came
// from. The last one matters most: offering a voice agent's examples inside a
// workflow project starts the user in a project whose coding agent has been told
// not to write voice agents.

import { describe, expect, test } from "vitest";
import { AGENT_STARTERS, sampleStarters, startersFor, WORKFLOW_STARTERS } from "./starters.ts";

describe("sampleStarters", () => {
  test("returns the requested count of distinct catalog entries", () => {
    const picked = sampleStarters("agent", 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((s) => s.label)).size).toBe(5);
    for (const starter of picked) expect(AGENT_STARTERS).toContain(starter);
  });

  test("caps at the catalog size instead of repeating", () => {
    const picked = sampleStarters("agent", AGENT_STARTERS.length + 10);
    expect(picked).toHaveLength(AGENT_STARTERS.length);
  });

  test("is deterministic for a fixed random source", () => {
    const zeros = sampleStarters("agent", 3, () => 0);
    // random() = 0 always picks the pool head: the first three in order.
    expect(zeros).toEqual(AGENT_STARTERS.slice(0, 3));
  });

  test("samples the WORKFLOW pool for a workflow project", () => {
    const picked = sampleStarters("workflow", WORKFLOW_STARTERS.length);
    // Exhaustive rather than a spot check: no agent starter may leak into a
    // workflow project's hero, whatever the random draw.
    expect(new Set(picked)).toEqual(new Set(WORKFLOW_STARTERS));
    for (const starter of picked) expect(AGENT_STARTERS).not.toContain(starter);
  });
});

describe("startersFor", () => {
  test("the two pools are disjoint and neither is empty", () => {
    expect(AGENT_STARTERS.length).toBeGreaterThan(0);
    expect(WORKFLOW_STARTERS.length).toBeGreaterThan(0);
    const agentLabels = new Set(AGENT_STARTERS.map((s) => s.label));
    for (const starter of WORKFLOW_STARTERS) expect(agentLabels).not.toContain(starter.label);
  });

  test("anything but 'workflow' is the agent pool", () => {
    expect(startersFor("agent")).toBe(AGENT_STARTERS);
    expect(startersFor("workflow")).toBe(WORKFLOW_STARTERS);
  });

  test("every starter has a non-empty prompt for the agent to act on", () => {
    // A blank prompt creates a project and then says nothing, which reads as a
    // broken button.
    for (const starter of [...AGENT_STARTERS, ...WORKFLOW_STARTERS]) {
      expect(starter.label.trim()).not.toBe("");
      expect(starter.prompt.trim().length).toBeGreaterThan(10);
    }
  });
});
