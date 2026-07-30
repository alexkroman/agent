// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the workflow combinators — pure orchestration over a fake
 * GenerateFn, no provider or network involvement.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GenerateFn, GenerateOptions, GenerateResult } from "./generate.ts";
import {
  evaluatorOptimizer,
  generateStructured,
  orchestrate,
  parallel,
  route,
  sequential,
} from "./workflow.ts";

/**
 * Fake GenerateFn: records every call and answers from a queue (or a
 * responder function). Schema calls get their response wrapped as `object`.
 */
function fakeGenerate(respond: (opts: GenerateOptions, call: number) => unknown): {
  generate: GenerateFn;
  calls: GenerateOptions[];
} {
  const calls: GenerateOptions[] = [];
  const generate: GenerateFn = async (opts): Promise<GenerateResult> => {
    calls.push(opts);
    const answer = respond(opts, calls.length - 1);
    if (opts.schema) return { text: JSON.stringify(answer), object: answer };
    return { text: String(answer) };
  };
  return { generate, calls };
}

describe("generateStructured", () => {
  it("converts the Zod schema to JSON Schema for the wire and validates the result", async () => {
    const { generate, calls } = fakeGenerate(() => ({ n: 7 }));
    const result = await generateStructured(generate, z.object({ n: z.number() }), "count");
    expect(result).toEqual({ n: 7 });
    expect(calls[0]?.schema).toMatchObject({ type: "object" });
    // $schema is stripped — the wire format matches the tool-schema helper.
    expect(calls[0]?.schema).not.toHaveProperty("$schema");
  });

  it("falls back to parsing text when the implementation returns no object", async () => {
    const generate: GenerateFn = async () => ({ text: JSON.stringify({ n: 3 }) });
    const result = await generateStructured(generate, z.object({ n: z.number() }), "count");
    expect(result).toEqual({ n: 3 });
  });

  it("rejects results that do not match the schema", async () => {
    const { generate } = fakeGenerate(() => ({ n: "not a number" }));
    await expect(
      generateStructured(generate, z.object({ n: z.number() }), "count"),
    ).rejects.toThrow();
  });
});

describe("sequential", () => {
  it("chains steps, feeding each the previous output", async () => {
    const { generate, calls } = fakeGenerate((opts) => `out(${opts.prompt})`);
    const result = await sequential(generate, [
      "draft",
      (prev) => `refine: ${prev}`,
      (prev, outputs) => ({ prompt: `final ${prev} after ${outputs.length}` }),
    ]);
    expect(calls.map((c) => c.prompt)).toEqual([
      "draft",
      "refine: out(draft)",
      "final out(refine: out(draft)) after 2",
    ]);
    expect(result.output).toBe("out(final out(refine: out(draft)) after 2)");
    expect(result.outputs).toHaveLength(3);
  });

  it("hands the initial input to the first functional step", async () => {
    const { generate } = fakeGenerate((opts) => opts.prompt.toUpperCase());
    const result = await sequential(generate, [(prev) => `echo ${prev}`], "seed");
    expect(result.output).toBe("ECHO SEED");
  });
});

describe("parallel", () => {
  it("runs all tasks and keys results to match", async () => {
    const { generate, calls } = fakeGenerate((opts) => `r:${opts.prompt}`);
    const results = await parallel(generate, {
      security: "review security",
      perf: { prompt: "review perf", temperature: 0 },
    });
    expect(results).toEqual({ security: "r:review security", perf: "r:review perf" });
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.prompt === "review perf")?.temperature).toBe(0);
  });

  it("rejects when any task fails", async () => {
    const generate: GenerateFn = async (opts) => {
      if (opts.prompt === "bad") throw new Error("provider down");
      return { text: "ok" };
    };
    await expect(parallel(generate, { a: "good", b: "bad" })).rejects.toThrow("provider down");
  });
});

describe("route", () => {
  const routes = {
    refund: { description: "Refund requests", handler: (input: string) => `refund: ${input}` },
    other: { description: "Everything else", handler: "generic reply" },
  };

  it("classifies then dispatches to the chosen route's handler", async () => {
    const { generate, calls } = fakeGenerate((opts) =>
      opts.schema ? { route: "refund", reasoning: "mentions money back" } : "done",
    );
    const result = await route(generate, { input: "I want my money back", routes });
    expect(result.route).toBe("refund");
    expect(result.reasoning).toBe("mentions money back");
    expect(result.output).toBe("done");
    expect(calls[0]?.prompt).toContain("refund: Refund requests");
    expect(calls[1]?.prompt).toBe("refund: I want my money back");
  });

  it("applies classifier overrides to the classification call only", async () => {
    const llm = { kind: "anthropic", options: { model: "m" } };
    const { generate, calls } = fakeGenerate((opts) =>
      opts.schema ? { route: "other", reasoning: "r" } : "done",
    );
    await route(generate, { input: "hi", routes, classifier: { llm } });
    expect(calls[0]?.llm).toBe(llm);
    expect(calls[1]?.llm).toBeUndefined();
  });

  it("rejects a classification outside the route set", async () => {
    const { generate } = fakeGenerate(() => ({ route: "invented", reasoning: "r" }));
    await expect(route(generate, { input: "hi", routes })).rejects.toThrow();
  });

  it("requires at least one route", async () => {
    const { generate } = fakeGenerate(() => "x");
    await expect(route(generate, { input: "hi", routes: {} })).rejects.toThrow(
      "at least one route",
    );
  });
});

describe("orchestrate", () => {
  const plan = { subtasks: [{ description: "part one" }, { description: "part two" }] };

  it("plans, fans out workers, and joins results by default", async () => {
    const { generate, calls } = fakeGenerate((opts) =>
      opts.schema ? plan : `done(${opts.prompt.split("\n").at(-1)})`,
    );
    const result = await orchestrate(generate, { task: "write a report" });
    expect(result.plan).toEqual(plan);
    expect(result.results).toHaveLength(2);
    expect(result.output).toContain("## part one");
    expect(result.output).toContain("## part two");
    // planning call + one worker per subtask, no synthesis call
    expect(calls).toHaveLength(3);
  });

  it("uses custom worker and synthesize steps", async () => {
    const { generate, calls } = fakeGenerate((opts) => (opts.schema ? plan : `<${opts.prompt}>`));
    const result = await orchestrate(generate, {
      task: "t",
      worker: (subtask) => `work:${subtask.description}`,
      synthesize: (results) => `merge:${results.join("|")}`,
    });
    expect(calls.map((c) => c.prompt).slice(1)).toEqual([
      "work:part one",
      "work:part two",
      "merge:<work:part one>|<work:part two>",
    ]);
    expect(result.output).toBe("<merge:<work:part one>|<work:part two>>");
  });

  it("truncates the plan at maxSubtasks", async () => {
    const bigPlan = { subtasks: Array.from({ length: 5 }, (_, i) => ({ description: `s${i}` })) };
    const { generate, calls } = fakeGenerate((opts) => (opts.schema ? bigPlan : "r"));
    const result = await orchestrate(generate, { task: "t", maxSubtasks: 2 });
    expect(result.plan.subtasks).toHaveLength(2);
    expect(calls).toHaveLength(3); // plan + 2 workers
  });
});

describe("evaluatorOptimizer", () => {
  it("returns on the first passing attempt", async () => {
    const { generate, calls } = fakeGenerate((opts) =>
      opts.schema ? { pass: true, feedback: "" } : "candidate-1",
    );
    const result = await evaluatorOptimizer(generate, { task: "write", criteria: "be good" });
    expect(result).toMatchObject({ output: "candidate-1", passed: true });
    expect(result.iterations).toHaveLength(1);
    expect(calls[1]?.prompt).toContain("be good");
  });

  it("feeds evaluator feedback into the retry and stops at maxIterations", async () => {
    let drafts = 0;
    const { generate, calls } = fakeGenerate((opts) =>
      opts.schema ? { pass: false, feedback: "too vague" } : `draft-${++drafts}`,
    );
    const result = await evaluatorOptimizer(generate, {
      task: "write",
      criteria: "specific",
      maxIterations: 2,
    });
    expect(result.passed).toBe(false);
    expect(result.output).toBe("draft-2");
    expect(result.iterations).toHaveLength(2);
    // The second draft prompt carries the rejection feedback and prior attempt.
    expect(calls[2]?.prompt).toContain("too vague");
    expect(calls[2]?.prompt).toContain("draft-1");
  });

  it("applies evaluator overrides to evaluation calls only", async () => {
    const llm = { kind: "openai", options: { model: "gpt" } };
    const { generate, calls } = fakeGenerate((opts) =>
      opts.schema ? { pass: true, feedback: "" } : "d",
    );
    await evaluatorOptimizer(generate, { task: "write", criteria: "c", evaluator: { llm } });
    expect(calls[0]?.llm).toBeUndefined();
    expect(calls[1]?.llm).toBe(llm);
  });
});
