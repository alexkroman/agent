// Copyright 2026 the AAI authors. MIT license.
/**
 * The `ctx.delegate` capability contract — hand a bounded, context-isolated
 * task to a SUBAGENT from inside a tool's `execute`.
 *
 * A subagent is a second tool loop: its own systemPrompt, its own model, its
 * own tools, and — the whole point — its own context window. The parent's
 * conversation never sees the subagent's steps, only what it returns. That is
 * the Vercel AI SDK's subagent pattern (`ToolLoopAgent` invoked from a tool),
 * expressed as a runtime capability like {@link GenerateFn} rather than as a
 * class an author instantiates: the model, the credential and the tool
 * executor are the RUNTIME's to own, and an author who reaches for
 * `new ToolLoopAgent(...)` in a tool body has to re-derive all three — which
 * is how a tool ends up reading `process.env` on a platform where every key
 * is user-provided.
 *
 * **`ctx.generate` is the one-shot; this is the loop.** Reach for `generate`
 * when one prompt answers the question. Reach for `delegate` when answering it
 * takes an unknown number of tool calls whose intermediate results the parent
 * has no reason to carry — a search-read-search-read pass that spends tens of
 * thousands of tokens and is worth one paragraph to the caller.
 *
 * ```ts
 * import { subagent, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const researcher = subagent({
 *   name: "researcher",
 *   description: "Researches a topic on the open web and reports what it found",
 *   systemPrompt: "Research the task with the tools you have.",
 *   expectedOutput:
 *     "A short summary of what you found — that summary is all the caller sees.",
 *   builtinTools: ["web_search", "visit_webpage"],
 *   maxSteps: 6,
 * });
 *
 * export default tool({
 *   description: "Research a question in depth",
 *   inputSchema: z.object({ question: z.string() }),
 *   execute: async ({ question }, ctx) => {
 *     const { text, toolCalls } = await ctx.delegate(researcher, { task: question });
 *     return `${text} (${toolCalls.length} lookups)`;
 *   },
 * });
 * ```
 *
 * ## Three fields that are not prompt text
 *
 * `systemPrompt` used to carry everything, and three jobs it was carrying badly
 * are their own fields now — each one a rule the runtime can hold rather than a
 * sentence an author has to remember:
 *
 * - {@link SubagentDef.expectedOutput} — what a good final message looks like,
 *   appended as its own section. The "tell it to summarize" rule, made
 *   structural.
 * - {@link SubagentDef.guardrail} — a check on the answer that can send it BACK
 *   with a complaint, up to {@link SubagentDef.maxRetries} times. The retry
 *   continues the run it is correcting, so the tool results the first attempt
 *   paid for are not bought twice.
 * - {@link SubagentDef.description} — what this specialist is for, read by
 *   whoever is CHOOSING one. Required of a roster entry (`agent({ subagents })`),
 *   ignored at a call site, where the choice was made in code.
 *
 * ## Two ways to choose a subagent
 *
 * `ctx.delegate(researcher, …)` names one in code: the author decided, and the
 * decision is as testable as any other branch. A ROSTER —
 * `agent({ subagents: { researcher, factChecker } })` — publishes the set as
 * one `delegate` tool and lets the MODEL choose from it per turn, which is the
 * shape a front desk with eight specialists needs and the one an eight-way
 * `if` was standing in for. See `sdk/subagent-roster.ts`; the two compose, and
 * a roster subagent is an ordinary `SubagentDef` a tool may still delegate to
 * by name.
 */

import type { LlmProvider } from "./providers.ts";
import type { InferSchemaOutput, StandardSchemaV1 } from "./standard-schema.ts";
import type { BuiltinTool, ToolDef } from "./types.ts";

/**
 * How many times a {@link SubagentDef.guardrail} may send an answer back when
 * the subagent names no {@link SubagentDef.maxRetries} of its own.
 *
 * Declared here rather than in `constants.ts` for the reason
 * `DEFAULT_STEP_MAX_ATTEMPTS` is declared beside `ctx.step`: a budget whose
 * only reader is one field is documented by sitting next to it.
 *
 * @public
 */
export const DEFAULT_GUARDRAIL_MAX_RETRIES = 1;

/**
 * A subagent definition — what {@link subagent} returns and
 * {@link DelegateFn} runs.
 *
 * Every field except `name` and `systemPrompt` is optional, and the defaults
 * are the parent agent's: the same LLM descriptor, no tools, and
 * the framework default (`DEFAULT_MAX_STEPS`) steps.
 *
 * @public
 */
export interface SubagentDef {
  /**
   * What this subagent is called. It reaches the model only as the id on the
   * subagent's own requests; its reader is a log line and a failure message
   * ("subagent \"researcher\" ran out of steps"), which is why it is required
   * and why an anonymous subagent is not expressible.
   */
  name: string;
  /**
   * What this subagent is FOR, in one line, written for whoever is choosing
   * between specialists rather than for the subagent itself.
   *
   * Ignored by call-site delegation — `ctx.delegate(researcher, …)` names the
   * subagent in code, so the choice is already made and there is nothing to
   * describe it to. It is REQUIRED of a subagent listed in
   * `agent({ subagents })`, and that is the whole reason it exists: a roster is
   * routed by the model, which reads this and nothing else. `agent()` refuses a
   * roster entry without one rather than shipping an agent that picks a
   * coworker off a list of bare names.
   *
   * Write it as the job, not the mechanism: "Researches a topic on the open web
   * and reports what it found" — not "calls web_search".
   */
  description?: string;
  /**
   * The subagent's system prompt.
   *
   * **Tell it to summarize** — or, better, declare {@link SubagentDef.expectedOutput}
   * and let the runtime say it. The parent gets {@link DelegateResult.text},
   * which is the subagent's FINAL message, so a subagent that ends its run by
   * saying "Done." has thrown away everything it learned and no amount of step
   * budget recovers it. This is the single most common way a subagent
   * disappoints, and it was a sentence every author had to remember to write
   * here; `expectedOutput` is the field that remembers it for them.
   */
  systemPrompt: string;
  /**
   * What a GOOD final message looks like — the shape of the answer, declared
   * apart from the instructions for producing it.
   *
   * The runtime appends it to the instructions as its own labelled section, so
   * it lands in the same place every time rather than wherever an author
   * happened to put it in prose. It is also what a {@link SubagentDef.guardrail}
   * is quoted against when it sends an answer back, so the two halves of "what
   * this run owes" stay one sentence rather than two that can disagree.
   *
   * Split out of `systemPrompt` for the reason CrewAI splits `expected_output`
   * off `description`: the failure it prevents is structural, not a matter of
   * prompting skill. A subagent whose brief says only what to DO ends its run
   * when it is done, which for a delegated run is precisely the wrong moment to
   * stop talking.
   *
   * ```ts
   * import { subagent } from "@alexkroman1/aai";
   *
   * const researcher = subagent({
   *   name: "researcher",
   *   systemPrompt: "Research the task with the tools you have.",
   *   expectedOutput:
   *     "A self-contained paragraph of what you found, naming the sources you " +
   *     "trusted. Three sentences is plenty; do not write a report.",
   * });
   * ```
   */
  expectedOutput?: string;
  /**
   * LLM for this subagent: a descriptor from `@alexkroman1/aai/llm`, or a
   * model-id string — the same shorthand as `agent({ llm })` and
   * {@link GenerateOptions.llm}. Defaults to the parent agent's own LLM.
   *
   * Naming a cheaper model here is the usual reason to set it: a subagent
   * doing lookups is spending most of its tokens on tool results, not on
   * reasoning.
   */
  llm?: LlmProvider | string;
  /**
   * The tools this subagent may call, by the name the model calls them by.
   *
   * A MAP rather than the filesystem registration `agent()` uses, and the
   * difference is deliberate: `tools/` declares what the CALLER can reach, and
   * this declares the strictly narrower set one delegated task can reach. A
   * subagent with no entry here and no `builtinTools` is a pure reasoning
   * pass — legal, and occasionally what you want.
   */
  tools?: Readonly<Record<string, ToolDef>>;
  /**
   * Builtins this subagent may call, resolved exactly as `agent({
   * builtinTools })` resolves them. Independent of the parent's: a parent that
   * enables none can still delegate to a subagent that searches the web.
   */
  builtinTools?: readonly BuiltinTool[];
  /**
   * Tool-calling steps this subagent may take before it must answer. Defaults
   * to the framework's `DEFAULT_MAX_STEPS`.
   *
   * The budget is the mechanism: a subagent told to "keep looking until sure"
   * is a subagent whose cost nobody can quote. Past the cap it is asked for
   * its answer with tools withheld, so a capped run still returns prose rather
   * than stopping mid-chain.
   */
  maxSteps?: number;
  /**
   * Check the subagent's answer, and send it back with a complaint when it is
   * not good enough.
   *
   * Return `true` to accept. Return a STRING to reject: the string is the
   * complaint, and the runtime re-runs the subagent with its own rejected
   * answer and that complaint appended to the conversation it already has — so
   * the retry keeps every tool result the first attempt paid for and is told
   * exactly what to fix. Bounded by {@link SubagentDef.maxRetries}.
   *
   * **A schema is not this.** `ctx.generate({ schema })` constrains the SHAPE
   * of an answer and cannot say that a citation is missing, that the sources
   * were all one publisher, or that the answer contradicts what the caller
   * already said. That judgement is a function, and until now the only place to
   * put it was after the delegation returned — where the one thing it could not
   * do was ask for a better answer.
   *
   * Runs on every attempt including the last. Throwing from it fails the
   * delegation, so a guardrail that cannot decide should return `true`.
   *
   * ```ts
   * import { subagent } from "@alexkroman1/aai";
   *
   * const researcher = subagent({
   *   name: "researcher",
   *   systemPrompt: "Research the task with the tools you have.",
   *   expectedOutput: "A paragraph naming the sources you trusted.",
   *   guardrail: ({ text, toolCalls }) =>
   *     toolCalls.length === 0
   *       ? "You answered without looking anything up. Search first, then answer."
   *       : text.length > 1200
   *         ? "Too long for someone listening on a phone — three sentences."
   *         : true,
   * });
   * ```
   */
  guardrail?: SubagentGuardrail;
  /**
   * How many times a {@link SubagentDef.guardrail} may send an answer back.
   *
   * @defaultValue `1` (`DEFAULT_GUARDRAIL_MAX_RETRIES`)
   *
   * One, not CrewAI's three, because a revision is another FULL run of the
   * subagent and the caller is on a live phone call — the third attempt at a
   * summary arrives well after the moment anyone was waiting for it. Raise it
   * for a subagent delegated from a workflow step, where nobody is listening.
   *
   * Exhausting the budget is not an error: the last attempt comes back with
   * {@link DelegateResult.accepted} `false` and the guardrail's
   * {@link DelegateResult.complaint}, because a voice agent holding a rejected
   * answer still has to say something, and it should be the caller's tool —
   * not the runtime — that decides what.
   */
  maxRetries?: number;
  /**
   * The SHAPE the final message must have — any
   * [Standard Schema](https://standardschema.dev), zod being the documented
   * default. The runtime parses the answer as JSON and checks it, and a reply
   * that does not match is sent BACK the way a
   * {@link SubagentDef.guardrail} rejection is, with the schema's own issues as
   * the complaint. Declare it through {@link subagent} to get the parsed value
   * typed on {@link TypedDelegateResult.object}.
   *
   * **This is not the guardrail, and the two are complementary.** A schema
   * settles the SHAPE — that a verdict is one of three words rather than a
   * sentence that implies one — where a guardrail is the judgement a shape
   * cannot express (a missing citation, sources that are all one publisher).
   * A subagent may declare both; the shape is checked first, because a
   * guardrail asked to judge a malformed answer is being asked the wrong
   * question.
   *
   * Reach for it when the CALLER has to branch on the answer.
   * `briefing-desk`'s fact-checker had a three-value verdict crossing three
   * layers as an English sentence prefix — restated in `expectedOutput`,
   * re-checked by a guardrail doing `startsWith`, and re-asked up to the retry
   * budget — because a model that wrote `"Confirmed - "` was wrong in a way
   * only prose could describe. A schema makes that a parse.
   *
   * ```ts
   * import { subagent } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const factChecker = subagent({
   *   name: "fact-checker",
   *   systemPrompt: "Check ONE claim against what you can find.",
   *   schema: z.object({
   *     verdict: z.enum(["confirmed", "contradicted", "unclear"]),
   *     detail: z.string(),
   *   }),
   * });
   * ```
   */
  schema?: StandardSchemaV1;
  /** Sampling temperature passed through to the provider. */
  temperature?: number;
  /** Cap on generated tokens per step, passed through to the provider. */
  maxOutputTokens?: number;
}

/**
 * Define a subagent.
 *
 * An identity function, like {@link tool} — it exists for the type, for the
 * name to grep for, and so a subagent is declared at module scope rather than
 * rebuilt inside `execute` on every call.
 *
 * @public
 */
export interface TypedSubagentDef<T> extends SubagentDef {
  schema: StandardSchemaV1<unknown, T>;
}

export function subagent<S extends StandardSchemaV1>(
  def: SubagentDef & { schema: S },
): TypedSubagentDef<InferSchemaOutput<S>>;
export function subagent(def: SubagentDef): SubagentDef;
export function subagent(def: SubagentDef): SubagentDef {
  return def;
}

/** Per-call options for {@link DelegateFn}. @public */
export interface DelegateOptions {
  /**
   * The task, as the subagent's first user message. Write it as a complete
   * brief: the subagent's context is ISOLATED, so it has not read the
   * conversation and knows nothing the task does not say.
   */
  task: string;
  /**
   * Extra context appended after the subagent's own `systemPrompt` for this
   * call — the caller's name, what has already been ruled out, the format the
   * answer should take. Absent by default, because a subagent that needs the
   * conversation to make sense is one whose task was underspecified.
   */
  context?: string;
  /**
   * Override the subagent's step budget for this call.
   */
  maxSteps?: number;
}

/** One tool call a subagent made, as reported back to the caller. @public */
export interface SubagentToolCall {
  /** The tool's name, as the subagent's model called it. */
  name: string;
  /** The arguments it was called with. */
  input: unknown;
}

/**
 * ONE attempt at an answer — what a {@link SubagentGuardrail} judges.
 *
 * `text` is the answer; `steps` and `toolCalls` are what the attempt COST,
 * which is the half a voice agent needs in order to say something true about
 * the wait ("I checked four sources"). They are a report, not a transcript: the
 * tool RESULTS stay inside the subagent's context, which is the entire reason
 * to have delegated.
 *
 * Split from {@link DelegateResult} so a guardrail cannot read the fields that
 * only make sense once the run is OVER — `revisions` counts the guardrail's own
 * verdicts, and asking it to judge an answer against its own past judgements is
 * not a check, it is a loop.
 *
 * @public
 */
export interface SubagentAnswer {
  /** The subagent's final message — see {@link SubagentDef.expectedOutput}. */
  text: string;
  /** How many steps this attempt took, including the final answering step. */
  steps: number;
  /** Every tool call this attempt made, in order. */
  toolCalls: readonly SubagentToolCall[];
}

/**
 * A guardrail's verdict: `true` to accept, or the complaint to send back.
 *
 * A bare string rather than `{ ok: false, reason }` because every rejection
 * must carry a reason — the retry is only worth running if the subagent is told
 * what was wrong, and a shape that lets the reason be omitted invites exactly
 * the rejection that teaches nothing.
 *
 * @public
 */
export type GuardrailVerdict = true | string;

/**
 * Judge one attempt — see {@link SubagentDef.guardrail}.
 *
 * @public
 */
export type SubagentGuardrail = (
  answer: SubagentAnswer,
) => GuardrailVerdict | Promise<GuardrailVerdict>;

/**
 * What one delegated run returns: the accepted attempt, plus what getting there
 * took.
 *
 * @public
 */
export interface DelegateResult extends SubagentAnswer {
  /**
   * How many times the guardrail sent an answer back before this one.
   *
   * `0` when it passed first time, and `0` for a subagent with no guardrail at
   * all. Reported for the same reason `steps` is: it is most of what the run
   * cost, and a wait that included two rewrites is a wait the caller was owed a
   * word about.
   */
  revisions: number;
  /**
   * Whether the guardrail ACCEPTED this answer. Always `true` when the subagent
   * declares no guardrail.
   *
   * `false` means the retry budget ran out and `text` is the last REJECTED
   * attempt. It comes back rather than throwing because the caller is a tool on
   * a live call and needs something to say — but it is a distinct value, not a
   * silently-returned failure, so a tool that cares can apologize instead of
   * reading a bad answer out loud.
   */
  accepted: boolean;
  /**
   * The guardrail's last complaint. Present exactly when `accepted` is `false`
   * — it is the reason, and a caller that reports the failure should quote it.
   */
  complaint?: string;
}

/**
 * Run a subagent to completion — the signature of `ctx.delegate`.
 *
 * Rejects when the run cannot be started (no LLM configured or named, an
 * unknown builtin) and when the parent turn is cancelled. A subagent whose own
 * TOOL fails does not reject: the failure goes back to the subagent as a tool
 * result, exactly as it would in the parent loop, and the subagent gets to
 * recover from it.
 *
 * A {@link SubagentDef.guardrail} that never accepts does not reject either —
 * the run comes back with {@link DelegateResult.accepted} `false`. The two
 * rejections above are both "this delegation could not happen"; a rejected
 * answer is a delegation that happened and produced something, and a caller on
 * a live call can use the difference.
 *
 * @public
 */
export interface TypedDelegateResult<T> extends DelegateResult {
  /**
   * The final message, PARSED against {@link SubagentDef.schema}.
   *
   * Present exactly when the subagent declares one, which is why it lives on
   * this type rather than on {@link DelegateResult}: a caller that declared no
   * shape should not be handed a field it has no way to read.
   *
   * `text` is still the raw answer beside it — the JSON the model wrote — so a
   * caller that wants to quote what came back can, and one that wants to branch
   * on it reads this.
   */
  object: T;
}

/**
 * Run a subagent to completion — the signature of `ctx.delegate`.
 *
 * OVERLOADED, the way {@link GenerateFn} is and for the same reason: a subagent
 * that declares a {@link SubagentDef.schema} answers with the parsed value
 * typed on {@link TypedDelegateResult.object}, and one that does not should not
 * be handed the field at all. Declaring the def through {@link subagent} is
 * what picks the overload — a `SubagentRoster` entry stays a plain
 * {@link SubagentDef}, so a model-chosen delegation is untyped, which is
 * correct: nothing at that call site knows which subagent the model picked.
 *
 * @public
 */
export type DelegateFn = {
  <T>(subagent: TypedSubagentDef<T>, options: DelegateOptions): Promise<TypedDelegateResult<T>>;
  (subagent: SubagentDef, options: DelegateOptions): Promise<DelegateResult>;
};
