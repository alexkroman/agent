// Copyright 2026 the AAI authors. MIT license.
/**
 * Agent workflow patterns — the five orchestration shapes from the Vercel
 * AI SDK's workflow guide (sequential chains, routing, parallel processing,
 * orchestrator–worker, evaluator–optimizer), adapted to AAI's split
 * architecture.
 *
 * Every combinator is a pure function over a {@link GenerateFn} — normally
 * `ctx.generate` from a tool's execute context — so the same workflow code
 * runs identically under `aai dev` (in-process) and on the platform (where
 * generation is proxied out of the guest sandbox over RPC). Nothing here
 * touches the network or Node.js APIs.
 *
 * Structured steps (routing's classifier, the orchestrator's plan, the
 * evaluator's verdict) use Zod schemas converted to JSON Schema on this
 * side of the RPC boundary via `z.toJSONSchema`, then re-validated here
 * with the original Zod schema — the wire carries only JSON.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { sequential } from "@alexkroman1/aai/workflow";
 * import { z } from "zod";
 *
 * const marketingCopy = tool({
 *   description: "Write marketing copy for a product",
 *   parameters: z.object({ product: z.string() }),
 *   execute: async ({ product }, ctx) =>
 *     await sequential(ctx.generate, [
 *       `Write persuasive marketing copy for: ${product}`,
 *       (copy) => `Tighten this copy to under 100 words:\n\n${copy}`,
 *     ]),
 * });
 * ```
 */

import { z } from "zod";
import type { GenerateFn, GenerateOptions } from "./generate.ts";

/** One LLM call: a bare prompt string or full {@link GenerateOptions}. */
export type GenerateRequest = string | GenerateOptions;

function toOptions(request: GenerateRequest): GenerateOptions {
  return typeof request === "string" ? { prompt: request } : request;
}

/**
 * Run one structured-output call: converts the Zod schema to JSON Schema
 * for the wire, then validates the result with the original schema. The
 * typed complement to passing raw JSON Schema in {@link GenerateOptions}.
 *
 * @public
 */
export async function generateStructured<T>(
  generate: GenerateFn,
  schema: z.ZodType<T>,
  request: GenerateRequest,
): Promise<T> {
  const options = toOptions(request);
  const { $schema: _omit, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  const result = await generate({ ...options, schema: jsonSchema });
  const raw: unknown = result.object !== undefined ? result.object : JSON.parse(result.text);
  return schema.parse(raw);
}

// ─── Sequential processing (chains) ──────────────────────────────────────────

/**
 * One step of a {@link sequential} chain: a fixed request, or a function of
 * the previous step's output (and all outputs so far) producing one.
 */
export type SequentialStep =
  | GenerateRequest
  | ((previous: string, outputs: readonly string[]) => GenerateRequest);

/**
 * Sequential processing — run steps in order, each seeing the previous
 * step's output. Use when a task decomposes into stages that build on each
 * other (draft → critique → rewrite).
 *
 * Returns the final step's output; `outputs` carries every intermediate.
 *
 * @public
 */
export async function sequential(
  generate: GenerateFn,
  steps: readonly SequentialStep[],
  input = "",
): Promise<{ output: string; outputs: string[] }> {
  const outputs: string[] = [];
  let previous = input;
  for (const step of steps) {
    const request = typeof step === "function" ? step(previous, outputs) : step;
    const result = await generate(toOptions(request));
    previous = result.text;
    outputs.push(previous);
  }
  return { output: previous, outputs };
}

// ─── Parallel processing ─────────────────────────────────────────────────────

/**
 * Parallel processing — run independent generation tasks concurrently and
 * collect the results under the same keys. Use for independent subtasks
 * (e.g. reviewing code for security, performance, and readability at once);
 * compose with another `generate` call or {@link sequential} to aggregate.
 *
 * Rejects if any task fails (fail-fast, like `Promise.all`).
 *
 * @public
 */
export async function parallel<K extends string>(
  generate: GenerateFn,
  tasks: Readonly<Record<K, GenerateRequest>>,
): Promise<Record<K, string>> {
  const keys = Object.keys(tasks) as K[];
  const results = await Promise.all(
    keys.map(async (key) => (await generate(toOptions(tasks[key]))).text),
  );
  return Object.fromEntries(keys.map((key, i) => [key, results[i]])) as Record<K, string>;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/** A destination for {@link route}: what it handles, and how. */
export type Route = {
  /** Shown to the classifier — when this route should be chosen. */
  description: string;
  /** The call to run for a routed input. */
  handler: GenerateRequest | ((input: string) => GenerateRequest);
};

/**
 * Routing — classify the input with one structured LLM call, then run the
 * matching route's handler. Use when inputs fall into categories that need
 * different prompts, models, or handling (support triage, intent dispatch).
 *
 * The classifier defaults to the same `generate` defaults; override its
 * model/system via `classifier`.
 *
 * @public
 */
export async function route(
  generate: GenerateFn,
  opts: {
    /** The input to classify and handle. */
    input: string;
    /** Candidate routes, keyed by name. */
    routes: Readonly<Record<string, Route>>;
    /** Overrides (llm, system, …) for the classification call. */
    classifier?: Omit<GenerateOptions, "prompt" | "schema">;
  },
): Promise<{ route: string; reasoning: string; output: string }> {
  const names = Object.keys(opts.routes);
  if (names.length === 0) throw new Error("route() requires at least one route");
  const ClassificationSchema = z.object({
    route: z.enum(names as [string, ...string[]]),
    reasoning: z.string(),
  });
  const catalog = Object.entries(opts.routes)
    .map(([name, r]) => `- ${name}: ${r.description}`)
    .join("\n");
  const picked = await generateStructured(generate, ClassificationSchema, {
    ...opts.classifier,
    prompt:
      `Classify the input into exactly one of these routes:\n${catalog}\n\n` +
      `Input:\n${opts.input}`,
  });
  const target = opts.routes[picked.route];
  // The enum schema guarantees membership; this guard satisfies indexed access.
  if (!target) throw new Error(`route(): classifier chose unknown route "${picked.route}"`);
  const request =
    typeof target.handler === "function" ? target.handler(opts.input) : target.handler;
  const result = await generate(toOptions(request));
  return { route: picked.route, reasoning: picked.reasoning, output: result.text };
}

// ─── Orchestrator–worker ─────────────────────────────────────────────────────

/** One planned subtask from the orchestrator. */
export type Subtask = { description: string };

/** Plan produced by the orchestrator: an ordered list of subtasks. */
export type Plan = { subtasks: Subtask[] };

const DEFAULT_MAX_SUBTASKS = 10;

/**
 * Orchestrator–worker — a planning call breaks the task into subtasks,
 * workers run them concurrently, and an optional synthesis call combines
 * the results (defaulting to a labeled join). Use when the decomposition
 * itself needs the model (research fan-out, multi-part authoring).
 *
 * @public
 */
export async function orchestrate(
  generate: GenerateFn,
  opts: {
    /** The overall task to plan and execute. */
    task: string;
    /** Overrides (llm, system, …) for the planning call. */
    orchestrator?: Omit<GenerateOptions, "prompt" | "schema">;
    /** Builds each worker's call; defaults to the subtask description with task context. */
    worker?: (subtask: Subtask, plan: Plan) => GenerateRequest;
    /** Builds the synthesis call from worker results; omit to join them. */
    synthesize?: (results: readonly string[], plan: Plan) => GenerateRequest;
    /** Cap on planned subtasks (default 10); the plan is truncated beyond it. */
    maxSubtasks?: number;
  },
): Promise<{ plan: Plan; results: string[]; output: string }> {
  const max = opts.maxSubtasks ?? DEFAULT_MAX_SUBTASKS;
  const PlanSchema = z.object({
    subtasks: z.array(z.object({ description: z.string() })).min(1),
  });
  const planned = await generateStructured(generate, PlanSchema, {
    ...opts.orchestrator,
    prompt:
      `Break the following task into at most ${max} independent subtasks. ` +
      `Each subtask description must be self-contained.\n\nTask:\n${opts.task}`,
  });
  const plan: Plan = { subtasks: planned.subtasks.slice(0, max) };

  const worker =
    opts.worker ??
    ((subtask: Subtask): GenerateRequest => ({
      prompt: `Overall task:\n${opts.task}\n\nComplete this subtask:\n${subtask.description}`,
    }));
  const results = await Promise.all(
    plan.subtasks.map(async (subtask) => (await generate(toOptions(worker(subtask, plan)))).text),
  );

  if (!opts.synthesize) {
    const output = plan.subtasks
      .map((subtask, i) => `## ${subtask.description}\n\n${results[i]}`)
      .join("\n\n");
    return { plan, results, output };
  }
  const synthesized = await generate(toOptions(opts.synthesize(results, plan)));
  return { plan, results, output: synthesized.text };
}

// ─── Evaluator–optimizer ─────────────────────────────────────────────────────

/** The evaluator's structured verdict on one candidate output. */
export type Evaluation = {
  /** Whether the candidate meets the bar as-is. */
  pass: boolean;
  /** Concrete feedback fed into the next attempt when `pass` is false. */
  feedback: string;
};

/** One attempt in an {@link evaluatorOptimizer} run. */
export type Iteration = { output: string; evaluation: Evaluation };

const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Evaluator–optimizer — generate a candidate, have an evaluator judge it,
 * and regenerate with the feedback until it passes or the iteration budget
 * runs out. Use when output quality is checkable by a model (tone rules,
 * completeness, format adherence) and worth a refinement loop.
 *
 * Returns the last candidate (the first passing one, or the final attempt)
 * plus the full iteration trace.
 *
 * @public
 */
export async function evaluatorOptimizer(
  generate: GenerateFn,
  opts: {
    /** The generation task. Feedback from failed attempts is appended. */
    task: GenerateRequest;
    /** Evaluation criteria shown to the evaluator. */
    criteria: string;
    /** Overrides (llm, system, …) for the evaluation calls. */
    evaluator?: Omit<GenerateOptions, "prompt" | "schema">;
    /** Attempt budget, including the first (default 3). */
    maxIterations?: number;
  },
): Promise<{ output: string; passed: boolean; iterations: Iteration[] }> {
  const maxIterations = Math.max(1, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const EvaluationSchema = z.object({ pass: z.boolean(), feedback: z.string() });
  const base = toOptions(opts.task);
  const iterations: Iteration[] = [];

  let output = "";
  for (let attempt = 0; attempt < maxIterations; attempt++) {
    const feedback = iterations.at(-1)?.evaluation.feedback;
    const prompt = feedback
      ? `${base.prompt}\n\nA previous attempt was rejected with this feedback — address it:\n${feedback}\n\nPrevious attempt:\n${iterations.at(-1)?.output}`
      : base.prompt;
    output = (await generate({ ...base, prompt })).text;

    const evaluation = await generateStructured(generate, EvaluationSchema, {
      ...opts.evaluator,
      prompt:
        "Evaluate the candidate against the criteria. Set pass=true only if it " +
        "fully satisfies them; otherwise give concrete, actionable feedback.\n\n" +
        `Criteria:\n${opts.criteria}\n\nCandidate:\n${output}`,
    });
    iterations.push({ output, evaluation });
    if (evaluation.pass) return { output, passed: true, iterations };
  }
  return { output, passed: false, iterations };
}
