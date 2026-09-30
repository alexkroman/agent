// Copyright 2026 the AAI authors. MIT license.
/**
 * `deepResearchWorkflow()` — a whole deep-research pass as one `workflow()`
 * definition: brief → plan → one researcher per angle → gaps → second wave →
 * report, every stage a durable step, every stage narrated.
 *
 * It is `research-handoff-agent`'s flow lifted out of the template, because the
 * second consumer copied it nearly verbatim and differed in exactly three
 * places: the prompts (who asked, and where the answer is read), the search
 * builtin the researcher gets, and what happens to the finished report. Those
 * are the options; the FLOW — which stages exist, in what order, under what
 * step names, and what each is allowed to cost — is what is shared.
 *
 * ```text
 *   writeBrief      1 step    the request as something a researcher is held to
 *   planAngles      1 step    the angles worth pursuing (the fan-out's width)
 *   investigate     N steps   one SUBAGENT each: search, read, cite, report
 *   findGaps        1 step    the supervisor's second look
 *   investigateGap  M steps   the second wave, when there is one
 *   writeReport     1 step    the report, then the summary a voice can carry
 *   deliver         yours     `options.deliver(result, input, ctx)` — its return is the run's output
 * ```
 *
 * ## The SDK cannot ship a step, and this does not
 *
 * A step is what a BODY wraps in `ctx.step(name, fn)`; this is a body, and the
 * step names above are its journal keys. They are the names the template's
 * runs were journaled under, so moving a template onto this is not a journal
 * break. `deliver` and `onFailure` get the run's `ctx` so the consumer owns its
 * own steps (a text, an announcement, a review `ctx.sleep`) under its own names.
 *
 * ## The budget is mechanism, not prompt
 *
 * Each researcher is a `subagent()` whose `maxSteps` is
 * {@link DeepResearchBudget.researcherSteps}: past it the researcher is asked
 * for its answer with its tools WITHHELD, so a capped angle still returns
 * findings. The pass as a whole is bounded by construction — at most
 * `maxAngles` angles, one gap wave of at most `maxGapAngles`, so the worst case
 * is `(maxAngles + maxGapAngles) × researcherSteps` tool-calling steps plus
 * five model calls. There is no wall-clock budget: a body is replayed, so a
 * deadline read outside a step is non-deterministic, and one read inside would
 * throw away angles the run has already paid for.
 *
 * ## A failure still fails the run
 *
 * `onFailure` runs when any stage (or `deliver`) throws, with the run's `ctx` —
 * to say so on a speaker, to post to a channel — and the ORIGINAL error is then
 * re-thrown, so the run is marked failed with its real reason. A suspension is
 * not a failure: waits park out of band and never reach a `catch`.
 *
 * `onFailure` may instead be a `{ run, maxAttempts }` handler — what
 * `sayFailureOnClient` (`@alexkroman1/aai/step`) returns — which is handed to
 * the ENGINE as `workflow({ onFailure })` rather than run from a body `catch`,
 * so it runs only once the engine has classified the throw as the run failing.
 *
 * @module
 */

import {
  DEFAULT_DEEP_RESEARCH_PROMPTS,
  type DeepResearchPrompts,
} from "./deep-research-prompts.ts";
import {
  allSources,
  findGaps,
  investigate,
  planAngles,
  writeBrief,
  writeReport,
} from "./deep-research-stages.ts";
import type {
  DeepResearchBudget,
  DeepResearchInputSchema,
  DeepResearchResearcher,
  DeepResearchResult,
  DeepResearchSettings,
} from "./deep-research-types.ts";
import { mapConcurrent } from "./map-concurrent.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { InferSchemaOutput } from "./schema.ts";
import type { StepGenerateOptions } from "./step-generate.ts";
import type { WorkflowDef } from "./workflow.ts";
import type { WorkflowContext } from "./workflow-ctx.ts";
import type { WorkflowFailureHook } from "./workflow-failure.ts";

/** The budget a pass gets for every field left out. @public */
export const DEFAULT_DEEP_RESEARCH_BUDGET: Readonly<Record<keyof DeepResearchBudget, number>> = {
  maxAngles: 4,
  maxGapAngles: 3,
  concurrency: 2,
  researcherSteps: 6,
  angleAttempts: 5,
};

/**
 * Options for {@link deepResearchWorkflow}.
 *
 * @typeParam P - The input schema; its parsed value must carry `topic`.
 * @typeParam R - What the run answers with: `deliver`'s return, or the
 *   {@link DeepResearchResult} itself when there is no `deliver`.
 *
 * @public
 */
export interface DeepResearchOptions<P extends DeepResearchInputSchema, R> {
  /** The workflow's description, for a page and `aai workflow`. */
  readonly description?: string;
  /** The run input. `topic` is what is researched; everything else is yours, for `deliver`. */
  readonly input: P;
  /** Who researches each angle and with what. */
  readonly researcher?: DeepResearchResearcher;
  /** What the pass may cost. */
  readonly budget?: DeepResearchBudget;
  /** Per-stage prompt overrides; an omitted stage keeps {@link DEFAULT_DEEP_RESEARCH_PROMPTS}. */
  readonly prompts?: DeepResearchPrompts;
  /** Gateway options for the plan, gap and report calls (`stepGenerate`'s). */
  readonly generate?: Pick<StepGenerateOptions, "model" | "apiKeyEnv" | "gatewayUrl">;
  /**
   * What happens to the finished report — file it, text it, say it, wait for a
   * review first. Runs in the BODY with the run's `ctx`, so anything
   * non-deterministic goes in a `ctx.step` of your own naming. What it returns
   * is the run's output.
   */
  readonly deliver?: (
    result: DeepResearchResult,
    input: InferSchemaOutput<P>,
    ctx: WorkflowContext,
  ) => Promise<R> | R;
  /**
   * Runs when the pass (or `deliver`) throws, before the run is marked failed
   * with the original error. Same rules as `deliver`: steps for anything
   * non-deterministic. If it throws itself, the ORIGINAL error still fails the
   * run — the reason a person reads is the research's, not the apology's.
   *
   * Or a `{ run, maxAttempts }` handler (`sayFailureOnClient`'s), passed to the
   * engine as the workflow's own `onFailure` — see the module doc.
   */
  readonly onFailure?:
    | ((error: unknown, input: InferSchemaOutput<P>, ctx: WorkflowContext) => Promise<void> | void)
    | {
        run: WorkflowFailureHook<InferSchemaOutput<P>>;
        maxAttempts?: number | undefined;
      };
}
/**
 * Declare a durable deep-research workflow, ready for `agent({ workflows })`.
 *
 * EXPERIMENTAL: the flow is `research-handoff-agent`'s, measured there; the
 * option shape is new and may change before it is promoted.
 *
 * @example
 * ```ts
 * import { deepResearchWorkflow } from "@alexkroman1/aai/experimental";
 * import { z } from "zod";
 *
 * declare function postReport(topic: string, report: string): Promise<void>;
 *
 * export const research = deepResearchWorkflow({
 *   description: "Research a topic and post the report",
 *   input: z.object({ topic: z.string().min(3) }),
 *   budget: { maxAngles: 3, researcherSteps: 5 },
 *   prompts: { summary: "Say the answer in one sentence." },
 *   deliver: async (result, input, ctx) => {
 *     await ctx.step("post", () => postReport(input.topic, result.report));
 *     return { topic: result.topic, summary: result.summary };
 *   },
 * });
 * ```
 *
 * @public
 */
export function deepResearchWorkflow<P extends DeepResearchInputSchema, R = DeepResearchResult>(
  options: DeepResearchOptions<P, R>,
): WorkflowDef<P, R> {
  const settings = resolveSettings(options);
  const { deliver } = options;
  // A function runs in the body's `catch`; a handler object goes to the engine.
  const onFailure = typeof options.onFailure === "function" ? options.onFailure : undefined;
  const engineFailure = typeof options.onFailure === "function" ? undefined : options.onFailure;

  async function run(input: InferSchemaOutput<P>, ctx: WorkflowContext): Promise<R> {
    try {
      const result = await researchPass(input.topic, ctx, settings);
      // With no `deliver`, R is its default — the result itself.
      return deliver ? await deliver(result, input, ctx) : (result as R);
    } catch (err) {
      if (onFailure) {
        try {
          await onFailure(err, input, ctx);
        } catch {
          // The original error is the run's reason; see `onFailure`'s doc.
        }
      }
      throw err;
    }
  }

  return {
    ...omitUndefined({ description: options.description, onFailure: engineFailure }),
    input: options.input,
    run,
  };
}

/** The options a stage reads, with every default filled. Exported for this module's spec. */
export function resolveSettings(
  options: Pick<
    DeepResearchOptions<DeepResearchInputSchema, unknown>,
    "budget" | "prompts" | "researcher" | "generate"
  >,
): DeepResearchSettings {
  return {
    budget: { ...DEFAULT_DEEP_RESEARCH_BUDGET, ...omitUndefined(options.budget ?? {}) },
    prompts: { ...DEFAULT_DEEP_RESEARCH_PROMPTS, ...omitUndefined(options.prompts ?? {}) },
    researcher: options.researcher ?? {},
    generate: options.generate ?? {},
  };
}

/** The flow. Step names are journal keys — renaming one strands every run in flight. */
async function researchPass(
  topic: string,
  ctx: WorkflowContext,
  settings: DeepResearchSettings,
): Promise<DeepResearchResult> {
  const { budget } = settings;
  const angleStep = { maxAttempts: budget.angleAttempts };
  const brief = await ctx.step("writeBrief", () => writeBrief(topic, settings));
  const angles = await ctx.step("planAngles", () => planAngles(brief, settings));
  // One step per angle, in an order a replay reproduces: `mapConcurrent` hands
  // items out from a monotonic cursor, so the Nth call issued is investigate#N
  // however they settle. A failed angle fails the run; its journaled siblings
  // replay for free on the resume.
  const first = await mapConcurrent(angles, budget.concurrency, (angle) =>
    ctx.step("investigate", () => investigate(brief, angle, settings), angleStep),
  );
  // Bounded to one extra wave by construction: this is called once. A different
  // step NAME from the first wave, so a run's history says which wave it was.
  const gaps =
    budget.maxGapAngles > 0
      ? await ctx.step("findGaps", () => findGaps(brief, first, settings))
      : [];
  const second = await mapConcurrent(gaps, budget.concurrency, (angle) =>
    ctx.step("investigateGap", () => investigate(brief, angle, settings), angleStep),
  );
  const notes = [...first, ...second];
  const written = await ctx.step("writeReport", () => writeReport(topic, brief, notes, settings));
  return { topic, brief, notes, sources: allSources(notes), ...written };
}
