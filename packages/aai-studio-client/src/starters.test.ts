// Copyright 2026 the AAI authors. MIT license.
// The hero shows a random sample of one starter catalog, not all of it —
// these pin the sample's size, uniqueness, and provenance, plus the property
// that makes two catalogs worth having: each one only offers starters the
// project's own system prompt is going to be told to build.

import { describe, expect, test } from "vitest";
import { AGENT_STARTERS, STARTERS, sampleStarters, WORKFLOW_STARTERS } from "./starters.ts";

describe("sampleStarters", () => {
  test("returns the requested count of distinct catalog entries", () => {
    const picked = sampleStarters(AGENT_STARTERS, 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((s) => s.label)).size).toBe(5);
    for (const starter of picked) expect(AGENT_STARTERS).toContain(starter);
  });

  test("caps at the catalog size instead of repeating", () => {
    const picked = sampleStarters(AGENT_STARTERS, AGENT_STARTERS.length + 10);
    expect(picked).toHaveLength(AGENT_STARTERS.length);
  });

  test("is deterministic for a fixed random source", () => {
    const zeros = sampleStarters(AGENT_STARTERS, 3, () => 0);
    // random() = 0 always picks the pool head: the first three in order.
    expect(zeros).toEqual(AGENT_STARTERS.slice(0, 3));
  });

  test("does not mutate the catalog it samples from", () => {
    // The pool is spread before splicing; without that, one page load would
    // empty the module-level catalog for the rest of the session.
    const before = AGENT_STARTERS.length;
    sampleStarters(AGENT_STARTERS, 5);
    expect(AGENT_STARTERS).toHaveLength(before);
  });
});

describe("the two catalogs", () => {
  test("every kind has enough entries to fill the hero's sample", () => {
    for (const [kind, catalog] of Object.entries(STARTERS)) {
      expect(catalog.length, kind).toBeGreaterThanOrEqual(5);
    }
  });

  test("no starter is offered under both kinds", () => {
    // The point of splitting them: a workflow-mode pick must never land a
    // voice-agent template in a project whose prompt forbids writing one.
    const agentPrompts = new Set(AGENT_STARTERS.map((s) => s.prompt));
    for (const starter of WORKFLOW_STARTERS) {
      expect(agentPrompts.has(starter.prompt), starter.label).toBe(false);
    }
  });

  test("the workflow catalog leads with the three workflow-app templates", () => {
    // `transcription-workflow` is the shape the workflow system prompt tells the
    // agent to start from, `link-digest` is the same shape at its smallest, and
    // `spoken-summary` is the one whose answer is a FILE. All three are
    // `workflowApp()`; a voice template here would contradict the prompt the
    // project runs under.
    expect(WORKFLOW_STARTERS.slice(0, 3).map((s) => s.prompt)).toEqual([
      "Use the transcription-workflow template.",
      "Use the link-digest template.",
      "Use the spoken-summary template.",
    ]);
  });

  test("no workflow starter names a voice template, and vice versa", () => {
    // `research-workflow` is the trap: it is a workflow template AND an `agent()`
    // (a caller is on the line, so a tool starts the run), so filing it under
    // Workflow would create it under a prompt that forbids what it is.
    const named = (list: readonly { prompt: string }[]) =>
      list.flatMap((s) => [...s.prompt.matchAll(/use the (\S+) template/gi)].map((m) => m[1]));
    expect(named(WORKFLOW_STARTERS)).toEqual([
      "transcription-workflow",
      "link-digest",
      "spoken-summary",
    ]);
    expect(named(AGENT_STARTERS)).not.toContain("transcription-workflow");
    expect(named(AGENT_STARTERS)).not.toContain("link-digest");
    expect(named(AGENT_STARTERS)).not.toContain("spoken-summary");
  });
});
