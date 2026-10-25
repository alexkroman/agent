// Copyright 2026 the AAI authors. MIT license.
/**
 * `workflow()`'s two-phase form and `describeRun`: what a declaration without
 * a body answers, and the one spoken line about a run.
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createRunSnapshot } from "./testing-workflows.ts";
import { describeRun, type WorkflowDef, workflow } from "./workflow.ts";
import type { WorkflowContext } from "./workflow-ctx.ts";

describe("workflow({ … }).body(fn)", () => {
  const input = z.object({ topic: z.string() });
  const output = z.object({ headline: z.string() });

  test("attaches the body and answers the finished definition, fields intact", () => {
    const declared = workflow({
      description: "Digest a topic",
      input,
      output,
      uploads: ["topic"],
      cancelNote: "Okay, dropped it.",
    });
    expect(typeof declared.body).toBe("function");
    expect("run" in declared).toBe(false);
    const run = async (i: { topic: string }) => ({ headline: i.topic });
    const def = declared.body(run);
    expect(def.run).toBe(run);
    expect(def).toMatchObject({
      description: "Digest a topic",
      input,
      output,
      uploads: ["topic"],
      cancelNote: "Okay, dropped it.",
    });
    expect("body" in def).toBe(false);
  });

  test("the single-phase form is unchanged: a def with `run` is the def", () => {
    const def = { input, run: async () => ({}) };
    expect(workflow(def)).toBe(def);
  });

  test("the attached body runs against a workflow context", async () => {
    const def = workflow({ input }).body(async (i, ctx: WorkflowContext) =>
      ctx.step("echo", () => i.topic),
    );
    const ctx = { step: async <T>(_n: string, fn: () => T) => fn() } as unknown as WorkflowContext;
    expect(await def.run({ topic: "otters" }, ctx)).toBe("otters");
  });
});

describe("describeRun", () => {
  const base = { workflow: "digest", key: "s" };

  test.each([
    [
      createRunSnapshot({ ...base, status: "pending" }),
      "the digest run is queued and has not started yet.",
    ],
    [createRunSnapshot({ ...base, status: "running" }), "the digest run is still in progress."],
    [
      createRunSnapshot({ ...base, status: "completed", output: 1 }),
      "the digest run has finished.",
    ],
    [createRunSnapshot({ ...base, status: "cancelled" }), "the digest run was cancelled."],
  ])("falls back to a sentence per status ($0.status)", (run, line) => {
    expect(describeRun(undefined, run)).toBe(line);
  });

  test("a failed run's sentence carries the error", () => {
    const run = createRunSnapshot({ ...base, status: "failed", error: "disk full" });
    expect(describeRun(undefined, run)).toBe("the digest run failed: disk full");
  });

  test("a label names the run in the fallback", () => {
    const run = {
      ...createRunSnapshot({ ...base, status: "running" }),
      label: "the plumber reminder",
    };
    expect(describeRun(undefined, run)).toBe("the plumber reminder is still in progress.");
  });

  test("the workflow's own describer wins, and is handed the typed snapshot", () => {
    const def: WorkflowDef<never, { headline: string }> = {
      run: async () => ({ headline: "x" }),
      describeRun: (run) =>
        run.status === "completed" ? `Done: ${run.output.headline}` : `Still ${run.status}.`,
    };
    const done = createRunSnapshot({
      ...base,
      status: "completed",
      output: { headline: "Otters" },
    });
    expect(describeRun(def, done)).toBe("Done: Otters");
    expect(describeRun(def, createRunSnapshot({ ...base, status: "running" }))).toBe(
      "Still running.",
    );
  });
});
