// Copyright 2026 the AAI authors. MIT license.
/**
 * A MODEL-GRADED verdict on a conversation: an LLM reads the transcript and
 * rules on each criterion the case wrote down.
 *
 * Deterministic readers answer "did it call `cancel_order`", and they should
 * stay the first thing a case reaches for. What they cannot answer is the half
 * of an agent's behaviour that is only visible as MEANING — "it confirmed the
 * date before booking", "it never promised a refund", "it stayed polite when the
 * caller got angry". A regex over `turn.text` is a flake for those, so this is
 * the instrument for them.
 *
 * Three decisions keep it honest:
 *
 * - **One ruling PER CRITERION, and the verdict is computed here.** The model
 *   is never asked "did it pass"; it is asked about each criterion with a
 *   reason, and {@link CallVerdict.pass} is `every` over those. A criterion the
 *   model skipped is a FAIL with that said, never a silent pass.
 * - **It is a noisy instrument, and it is treated as one.** Run a judged case
 *   under `AAI_EVAL_REPEAT` and read the spread; a live eval reports rather than
 *   gates for exactly this reason (see the root guide's tier table).
 * - **In a keyless run the judge is SCRIPTED too.** `describeEval`'s
 *   `stubJudge` supplies the rulings, and a stub verdict is marked
 *   ({@link CallVerdict.scripted}) so nobody reads a wiring check as a grade.
 *
 * @module
 */

import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { isRecord } from "@alexkroman1/aai/utils";
import { createGenerateFn } from "../generate.ts";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import type { EvalTurn } from "./session.ts";
import type { SimulatedCall } from "./simulate.ts";

/** One criterion's ruling. */
export type CriterionVerdict = {
  readonly criterion: string;
  readonly pass: boolean;
  /** The judge's reason, in a sentence or two. */
  readonly reason: string;
};

/** The judge's verdict over a whole conversation. */
export type CallVerdict = {
  /** Every criterion passed. */
  readonly pass: boolean;
  /** One ruling per criterion, in the order they were given. */
  readonly criteria: readonly CriterionVerdict[];
  /** The judge's overall summary. */
  readonly summary: string;
  /** The rulings came from a script (`stubJudge`), not a model's reading. */
  readonly scripted: boolean;
  /** The failed rulings, one per line — what a failure message should print. */
  explain(): string;
};

/** What {@link judgeCall} takes. */
export type JudgeCallOptions = {
  /**
   * What must be true of the conversation, one claim each — "the agent
   * confirmed the order number before cancelling". Phrase each so it can be
   * ruled on from the transcript alone.
   */
  readonly criteria: readonly string[];
  /** The JUDGING model. Any `@alexkroman1/aai/llm` descriptor. */
  readonly llm: LlmProvider;
  /** Where the judge's credential is resolved from. Defaults to this machine's. */
  readonly providerEnv?: ProviderEnv;
  /** Extra context the judge should know — the agent's purpose, a policy. */
  readonly context?: string;
};

/** What a judge may be handed: a simulated call, a list of turns, or a transcript. */
export type JudgeInput = SimulatedCall | readonly EvalTurn[] | string;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "The criterion's number, from 1." },
          pass: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["index", "pass", "reason"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["criteria", "summary"],
  additionalProperties: false,
} as const;

function transcriptOf(input: JudgeInput): string {
  if (typeof input === "string") return input;
  if ("transcript" in input) return input.transcript();
  return input
    .map((turn, i) => {
      const tools = turn.toolCalls.map(
        (call) =>
          `  [tool ${call.name}(${JSON.stringify(call.args)}) → ${call.result ?? "(none)"}]`,
      );
      return [`Turn ${i + 1}:`, ...tools, `Agent: ${turn.text}`].join("\n");
    })
    .join("\n");
}

function judgePrompt(transcript: string, options: JudgeCallOptions): string {
  const numbered = options.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    ...(options.context === undefined ? [] : ["Context:", options.context, ""]),
    "Transcript (bracketed lines are tool calls the agent made, with their results):",
    transcript,
    "",
    "Criteria:",
    numbered,
    "",
    "Rule on EVERY criterion from the transcript alone. A criterion the transcript gives",
    "no evidence for is NOT met. Answer with one ruling per criterion, by its number.",
  ].join("\n");
}

const JUDGE_SYSTEM =
  "You are a strict evaluator of conversations between a voice agent and a caller. " +
  "You judge only what the transcript shows, never what the agent might have meant.";

/**
 * Match the model's rulings to the criteria by number. A criterion with no
 * ruling FAILS, with a reason saying so — the one outcome this must never
 * produce is a pass the judge never gave.
 */
function rulingsOf(criteria: readonly string[], raw: unknown): CriterionVerdict[] {
  const given = isRecord(raw) && Array.isArray(raw.criteria) ? raw.criteria : [];
  return criteria.map((criterion, i) => {
    const ruling = given.find((r: unknown) => isRecord(r) && r.index === i + 1);
    if (!(isRecord(ruling) && typeof ruling.pass === "boolean")) {
      return { criterion, pass: false, reason: "the judge returned no ruling for this criterion" };
    }
    return {
      criterion,
      pass: ruling.pass,
      reason: typeof ruling.reason === "string" ? ruling.reason : "",
    };
  });
}

/** Build a {@link CallVerdict} from rulings. */
function verdictOf(
  criteria: readonly CriterionVerdict[],
  summary: string,
  scripted: boolean,
): CallVerdict {
  return {
    pass: criteria.every((c) => c.pass),
    criteria,
    summary,
    scripted,
    explain: () =>
      criteria
        .filter((c) => !c.pass)
        .map((c) => `✗ ${c.criterion} — ${c.reason}`)
        .join("\n") || "all criteria passed",
  };
}

/**
 * Have a model rule on `criteria` over `input`, and hand back the verdict.
 *
 * ```ts
 * import { llm } from "@alexkroman1/aai/llm";
 * import { judgeCall, type SimulatedCall } from "@alexkroman1/aai-runtime/eval/simulate";
 *
 * export async function grade(call: SimulatedCall): Promise<void> {
 *   const verdict = await judgeCall(call, {
 *     criteria: [
 *       "The agent looked the order up before saying whether it shipped.",
 *       "The agent never asked for a card number.",
 *     ],
 *     llm: llm({ provider: "anthropic", model: "claude-sonnet-5" }),
 *   });
 *   if (!verdict.pass) throw new Error(verdict.explain());
 * }
 * ```
 *
 * @throws if `criteria` is empty — a judge with nothing to rule on passes
 *   vacuously, which is the silent green this module exists not to produce.
 */
export async function judgeCall(
  input: JudgeInput,
  options: JudgeCallOptions,
): Promise<CallVerdict> {
  return await runJudge(input, options, false);
}

/**
 * {@link judgeCall}, told whether its model is a SCRIPT. In-package only: the
 * keyless `describeEval` path is the one caller that knows, and a public flag
 * would let a live verdict be labelled scripted or the reverse.
 */
export async function runJudge(
  input: JudgeInput,
  options: JudgeCallOptions,
  scripted: boolean,
): Promise<CallVerdict> {
  if (options.criteria.length === 0) {
    throw new Error("judgeCall: pass at least one criterion — an empty list passes vacuously.");
  }
  const generate = createGenerateFn({
    llm: options.llm,
    env: options.providerEnv ?? withHostCredentialFallback({}),
  });
  const { object } = await generate({
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(transcriptOf(input), options),
    schema: VERDICT_SCHEMA,
    temperature: 0,
  });
  const summary = isRecord(object) && typeof object.summary === "string" ? object.summary : "";
  return verdictOf(rulingsOf(options.criteria, object), summary, scripted);
}
