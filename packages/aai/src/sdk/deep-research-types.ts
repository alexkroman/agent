// Copyright 2026 the AAI authors. MIT license.
/**
 * The data a deep-research pass passes between its stages, and the option
 * shapes both halves read — a type-only LEAF, so `deep-research.ts` (the
 * factory and the flow) and `deep-research-stages.ts` (the steps) share it
 * without importing each other.
 *
 * @module
 */

import type { DeepResearchPrompts } from "./deep-research-prompts.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";
import type { StepGenerateOptions } from "./step-generate.ts";
import type { SubagentDef } from "./subagent.ts";
import type { BuiltinTool, ToolSet } from "./types.ts";

/** One source a researcher actually used. @public */
export interface DeepResearchSource {
  readonly title: string;
  readonly url: string;
}

/** What one researcher concluded about one angle. @public */
export interface DeepResearchNote {
  readonly angle: string;
  /** The researcher's final message — kept long on purpose; the report stage summarizes. */
  readonly findings: string;
  readonly sources: readonly DeepResearchSource[];
}

/** The request as a researcher is held to it. @public */
export interface DeepResearchBrief {
  readonly brief: string;
  /** What a complete answer has to contain — what the gap pass measures against. */
  readonly criteria: readonly string[];
}

/**
 * What a finished pass hands `deliver` — and, with no `deliver`, what the run
 * answers with.
 *
 * @public
 */
export interface DeepResearchResult {
  readonly topic: string;
  readonly brief: DeepResearchBrief;
  /** Both waves, first wave first. */
  readonly notes: readonly DeepResearchNote[];
  /** Every distinct source, in the order found — `[n]` in `report` is `sources[n - 1]`. */
  readonly sources: readonly DeepResearchSource[];
  /** The written report, citing `sources` by number. */
  readonly report: string;
  /** The report reduced to what a voice agent can say. */
  readonly summary: string;
}

/**
 * What a pass may cost. Every field is optional; the defaults are
 * `DEFAULT_DEEP_RESEARCH_BUDGET`.
 *
 * @public
 */
export interface DeepResearchBudget {
  /** Most angles the first wave may carry, whatever the planner asks for. */
  readonly maxAngles?: number | undefined;
  /** Most angles the gap wave may carry. `0` skips the gap pass entirely. */
  readonly maxGapAngles?: number | undefined;
  /** Angles investigated at once. The far side of every one is a rate limit. */
  readonly concurrency?: number | undefined;
  /** Tool-calling steps one researcher may take before it must answer (`SubagentDef.maxSteps`). */
  readonly researcherSteps?: number | undefined;
  /** Attempts an `investigate` step gets — an angle is the expensive thing to lose. */
  readonly angleAttempts?: number | undefined;
}

/**
 * The researcher each angle is handed to.
 *
 * @public
 */
export interface DeepResearchResearcher {
  /**
   * The builtins it searches and reads with. Default
   * `["web_search", "visit_webpage"]` (keyless); an agent holding a Brave key
   * passes `["brave_search", "visit_webpage"]`. A `visit_webpage` call is what
   * a researcher that forgot to `cite` falls back to for its sources.
   */
  readonly builtinTools?: readonly BuiltinTool[];
  /** Tools of your own beside the `cite` tool the pass adds (which may not be replaced). */
  readonly tools?: ToolSet;
  /** The researcher's model. Default: the gateway default `stepDelegate` binds. */
  readonly llm?: SubagentDef["llm"];
}

/** An input schema whose parsed value carries the `topic` to research. @public */
export type DeepResearchInputSchema = StandardSchemaV1<
  unknown,
  { topic: string } & Record<string, unknown>
>;

/** Everything a stage reads, resolved once at declaration. Not on any subpath. */
export type DeepResearchSettings = {
  readonly budget: Readonly<Record<keyof DeepResearchBudget, number>>;
  readonly prompts: Readonly<Record<keyof DeepResearchPrompts, string>>;
  readonly researcher: DeepResearchResearcher;
  readonly generate: Pick<StepGenerateOptions, "model" | "apiKeyEnv" | "gatewayUrl">;
};
