// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `deepResearchWorkflow` — its option resolution, and its BODY
 * driven through `createWorkflowContext`, which records the steps it asks for.
 * The steps themselves are `deep-research-stages.test.ts`; the body on the real
 * replay engine is `research-handoff-agent`'s spec (the template is the worked
 * example, and `aai-runtime` is not a dependency here).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_DEEP_RESEARCH_BUDGET,
  deepResearchWorkflow,
  resolveSettings,
} from "./deep-research.ts";
import { DEFAULT_DEEP_RESEARCH_PROMPTS } from "./deep-research-prompts.ts";
import { FatalError } from "./step-error-classes.ts";
import { installStubGateway } from "./testing-vitest.ts";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS } from "./workflow-ctx-options.ts";

const brief = { brief: "How otters use tools", criteria: ["Which species", "How it is learned"] };
const a = { title: "A", url: "https://a.example" };
const b = { title: "B", url: "https://b.example" };

beforeEach(() => {
  vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
});

describe("resolveSettings", () => {
  test("fills every field left out, and an explicit undefined does not unset one", () => {
    const settings = resolveSettings({
      budget: { maxAngles: 2, researcherSteps: undefined },
      prompts: { summary: "One sentence." },
    });
    expect(settings.budget).toEqual({ ...DEFAULT_DEEP_RESEARCH_BUDGET, maxAngles: 2 });
    expect(settings.prompts).toEqual({
      ...DEFAULT_DEEP_RESEARCH_PROMPTS,
      summary: "One sentence.",
    });
  });
});

describe("the body", () => {
  const input = z.object({ topic: z.string(), who: z.string() });
  /** The skeleton of a run: every step the body READS, answered. */
  const skeleton = {
    writeBrief: brief,
    planAngles: ["Adoption", "Tooling"],
    investigate: { angle: "Adoption", findings: "f", sources: [a] },
    findGaps: ["Cost"],
    investigateGap: { angle: "Cost", findings: "g", sources: [a, b] },
    writeReport: { report: "r [1]", summary: "s" },
  };

  test("runs the stages in order under the journal names, angles with extra attempts", async () => {
    const def = deepResearchWorkflow({ input });
    const ctx = createWorkflowContext({ runSteps: false, results: skeleton });
    const out = await def.run({ topic: "t", who: "Ada" }, ctx);
    expect(ctx.steps.map((step) => step.name)).toEqual([
      "writeBrief",
      "planAngles",
      "investigate",
      "investigate",
      "findGaps",
      "investigateGap",
      "writeReport",
    ]);
    for (const step of ctx.steps.filter((one) => one.name.startsWith("investigate"))) {
      expect(step.maxAttempts).toBeGreaterThan(DEFAULT_STEP_MAX_ATTEMPTS);
    }
    // No `deliver`: the result IS the output.
    expect(out).toMatchObject({ topic: "t", report: "r [1]", summary: "s", sources: [a, b] });
    expect(out.notes).toHaveLength(3);
  });

  test("maxGapAngles: 0 skips the gap pass entirely", async () => {
    const def = deepResearchWorkflow({ input, budget: { maxGapAngles: 0 } });
    const ctx = createWorkflowContext({ runSteps: false, results: skeleton });
    await def.run({ topic: "t", who: "Ada" }, ctx);
    expect(ctx.steps.map((step) => step.name)).not.toContain("findGaps");
    expect(ctx.steps.map((step) => step.name)).not.toContain("investigateGap");
  });

  test("deliver gets the result, the typed input and ctx, and its return is the output", async () => {
    const def = deepResearchWorkflow({
      input,
      description: "d",
      deliver: async (result, got, ctx) => {
        const filed = await ctx.step("file", () => `filed for ${got.who}`);
        return { summary: result.summary, filed };
      },
    });
    expect(def.description).toBe("d");
    const ctx = createWorkflowContext({ runSteps: false, results: { ...skeleton, file: "ok" } });
    expect(await def.run({ topic: "t", who: "Ada" }, ctx)).toEqual({ summary: "s", filed: "ok" });
    expect(ctx.steps.at(-1)?.name).toBe("file");
  });

  test("onFailure runs with the ORIGINAL error, which still fails the run", async () => {
    installStubGateway([""], { status: 401 });
    const seen: unknown[] = [];
    const def = deepResearchWorkflow({
      input,
      onFailure: async (err, got, ctx) => {
        seen.push(err, got.who);
        await ctx.step("announceFailure", () => undefined);
      },
    });
    // Steps RUN here, so `writeBrief` really reaches the (refusing) gateway.
    const ctx = createWorkflowContext({ results: { announceFailure: null } });
    const err = await Promise.resolve(def.run({ topic: "t", who: "Ada" }, ctx)).catch(
      (thrown: unknown) => thrown,
    );
    expect(FatalError.is(err)).toBe(true);
    expect(seen).toEqual([err, "Ada"]);
    expect(ctx.steps.map((step) => step.name)).toContain("announceFailure");
  });

  test("a { run, maxAttempts } onFailure goes to the ENGINE, not the body's catch", async () => {
    const boom = new Error("research failed");
    const hook = vi.fn(async () => undefined);
    const def = deepResearchWorkflow({
      input,
      deliver: () => {
        throw boom;
      },
      onFailure: { run: hook, maxAttempts: 7 },
    });
    expect(def.onFailure).toEqual({ run: hook, maxAttempts: 7 });
    const ctx = createWorkflowContext({ runSteps: false, results: skeleton });
    await expect(def.run({ topic: "t", who: "Ada" }, ctx)).rejects.toBe(boom);
    expect(hook).not.toHaveBeenCalled();
  });

  test("a function onFailure leaves the workflow's own onFailure unset", () => {
    const def = deepResearchWorkflow({ input, onFailure: () => undefined });
    expect(def.onFailure).toBeUndefined();
  });

  test("an onFailure that throws does not replace the run's reason", async () => {
    const boom = new Error("research failed");
    const def = deepResearchWorkflow({
      input,
      deliver: () => {
        throw boom;
      },
      onFailure: () => {
        throw new Error("apology failed");
      },
    });
    const ctx = createWorkflowContext({ runSteps: false, results: skeleton });
    await expect(def.run({ topic: "t", who: "Ada" }, ctx)).rejects.toBe(boom);
  });
});
