// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.report` over the `/testing` recorder: one step, named by the body, with
 * no retry budget to spend.
 */

import { describe, expect, test } from "vitest";
import { publishStepReporter } from "./step-report.ts";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";
import { reportWorkflow } from "./workflow-report.ts";

describe("ctx.report", () => {
  test("journals ONE step under the body's name and writes the line through it", async () => {
    const lines: string[] = [];
    publishStepReporter(async (line) => {
      lines.push(String(line));
    });
    try {
      const ctx = createWorkflowContext();
      await ctx.report("announce", "Transcribing the recording.");
      expect(ctx.steps).toEqual([{ name: "announce", maxAttempts: 1 }]);
      expect(lines).toEqual(["Transcribing the recording."]);
    } finally {
      publishStepReporter(undefined);
    }
  });

  test("is the same composition on a bare host, so every context agrees", async () => {
    const seen: string[] = [];
    const host = {
      step: async <T>(name: string, fn: () => Promise<T> | T) => {
        seen.push(name);
        return await fn();
      },
    };
    publishStepReporter(async () => undefined);
    try {
      await expect(reportWorkflow(host, "note", "x")).resolves.toBeUndefined();
      expect(seen).toEqual(["note"]);
    } finally {
      publishStepReporter(undefined);
    }
  });
});
