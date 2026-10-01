// Copyright 2026 the AAI authors. MIT license.
/**
 * `speaker()` — ONE definition for every second voice an agent has, whether the
 * caller hears it or not, and the `ctx.delegate` contract that runs one OFF the
 * line.
 *
 * A {@link SpeakerDef} is a name, a description the model routes on, a system
 * prompt, its own tools and model knobs. What it is FOR is decided by where it
 * runs, not by a second schema:
 *
 * - **Off the line** — `ctx.delegate(def, { task })` runs it as a second tool
 *   loop with its own context window; the caller never hears it, the calling
 *   tool gets its conclusion. That is the AI SDK's subagent pattern
 *   (`ToolLoopAgent` from a tool), with the model, the credential and the tool
 *   executor owned by the runtime. `ctx.generate` is the one-shot; this is the
 *   loop.
 * - **On the line** — a {@link SpeakerDef.speaks} entry of the agent's
 *   `roster()` is handed the CALL (`handoff`): its prompt, tools and knobs are
 *   in force over the same history and slots. See `sdk/roster.ts`.
 *
 * One roster lists both, and mints the two routing tools from it: `delegate`
 * over the entries that do not speak, `handoff` over the ones that do.
 *
 * ```ts
 * import { speaker, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const researcher = speaker({
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
 * The off-line fields — `expectedOutput`, `guardrail`/`maxRevisions`, `schema`,
 * `llm`, `builtinTools`, `maxSteps` — shape a DELEGATED run; `toolChoice` is
 * read only on the line. A speaking entry may still be delegated to in code.
 */

import type { ModelTuning } from "./agent-model-tuning.ts";
import type { PipelineTuning } from "./agent-tuning.ts";
import type { LlmSpec } from "./providers/llm/llm.ts";
import type { InferSchemaOutput, StandardSchemaV1 } from "./standard-schema.ts";
import type { BuiltinTool, ToolChoice, ToolMap } from "./types.ts";

/**
 * How many times a {@link SpeakerDef.guardrail} may send an answer back when
 * the subagent names no {@link SpeakerDef.maxRevisions} of its own.
 *
 * Declared here rather than in `constants.ts` for the reason
 * `DEFAULT_STEP_MAX_ATTEMPTS` is declared beside `ctx.step`: a budget whose
 * only reader is one field is documented by sitting next to it.
 *
 * @public
 */
export const DEFAULT_GUARDRAIL_MAX_REVISIONS: number = 1;

/**
 * A speaker definition — what {@link speaker} returns, {@link DelegateFn} runs
 * off the line and a `roster()` hands the call to.
 *
 * Every field except `name` and `systemPrompt` is optional, and the defaults
 * are the parent agent's: the same LLM descriptor, no tools, and the framework
 * default (`DEFAULT_MAX_STEPS`) steps.
 *
 * It takes {@link ModelTuning} WITHOUT `maxRetries`: on `ModelTuning` that means
 * provider retries, and the guardrail budget is {@link SpeakerDef.maxRevisions}.
 *
 * @typeParam N - The `name`, as a literal when {@link speaker} infers it — what
 *   lets `Roster.handoff` refuse a misspelled target at compile time.
 *
 * @public
 */
export interface SpeakerDef<N extends string = string> extends Omit<ModelTuning, "maxRetries"> {
  /**
   * What this speaker is called: the value of the `delegate`/`handoff` tool's
   * argument, the id on its own requests, and what a log line names.
   */
  name: N;
  /**
   * What this speaker is FOR, in one line, written for whoever is choosing
   * between them — the minted `delegate` and `handoff` tools' descriptions are
   * these lines. REQUIRED of a roster entry (`roster()` refuses one without
   * it); ignored by `ctx.delegate(def, …)` in code, where the choice is made.
   *
   * Write it as the job, not the mechanism: "Researches a topic on the open web
   * and reports what it found" — not "calls web_search".
   */
  description?: string;
  /**
   * Whether the CALLER hears this speaker. `true` puts it on the roster's
   * `handoff` tool — it takes the call, over the same history and slots; absent
   * or `false` puts it on `delegate` — it runs off the line and hands back an
   * answer. The first speaking entry of a roster answers the call.
   */
  speaks?: boolean;
  /** The model's tool-choice policy while this speaker is ON THE LINE. */
  toolChoice?: ToolChoice;
  /**
   * How interruptible the agent is while this speaker is ON THE LINE — the
   * agent's own `interruption` group, overriding it field by field (a dialog
   * state's own `interruption` overrides this in turn: dialog → speaker →
   * agent). Read only for a `speaks: true` entry. Pipeline only.
   */
  interruption?: PipelineTuning["interruption"];
  /**
   * The speaker's instructions — on the line and off it.
   *
   * **Tell it to summarize** — or, better, declare {@link SpeakerDef.expectedOutput}
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
   * happened to put it in prose. It is also what a {@link SpeakerDef.guardrail}
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
   * import { speaker } from "@alexkroman1/aai";
   *
   * const researcher = speaker({
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
  llm?: LlmSpec;
  /**
   * The tools this subagent may call, by the name the model calls them by.
   *
   * A MAP rather than the filesystem registration `agent()` uses: `tools/`
   * declares what every turn can reach, and this the narrower set this speaker
   * owns. Off the line, they are its delegated loop's tools; on the line, the
   * roster gates them to the turns it is speaking (one owner per name). An
   * off-line speaker with no tools and no `builtinTools` is a pure reasoning
   * pass.
   */
  tools?: ToolMap;
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
   * exactly what to fix. Bounded by {@link SpeakerDef.maxRevisions}.
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
   * import { speaker } from "@alexkroman1/aai";
   *
   * const researcher = speaker({
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
  guardrail?: SpeakerGuardrail;
  /**
   * How many times a {@link SpeakerDef.guardrail} may send an answer back.
   *
   * @defaultValue `1` (`DEFAULT_GUARDRAIL_MAX_REVISIONS`)
   *
   * **Was `maxRetries`.** Renamed because {@link ModelTuning.maxRetries} retries
   * a provider REQUEST that failed (a 429, a socket reset), where this re-runs a
   * delegation that SUCCEEDED and was judged not good enough. A subagent does
   * not accept `maxRetries` at all, so code written against the old name fails
   * to compile rather than quietly meaning something else.
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
  maxRevisions?: number;
  /**
   * Not a field. Typed as the message that names the rename, so
   * `speaker({ maxRetries: 3 })` fails to compile with the fix in the error
   * rather than with a bare excess-property one — the idiom `agent({ tools })`
   * uses. See {@link SpeakerDef.maxRevisions}.
   */
  maxRetries?: "a speaker's guardrail budget is `maxRevisions`; a delegated run takes no provider-retry setting";
  /**
   * The SHAPE the final message must have — any
   * [Standard Schema](https://standardschema.dev), zod being the documented
   * default. The runtime parses the answer as JSON and checks it, and a reply
   * that does not match is sent BACK the way a
   * {@link SpeakerDef.guardrail} rejection is, with the schema's own issues as
   * the complaint. Declare it through {@link speaker} to get the parsed value
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
   * `topic-briefing-agent`'s fact-checker had a three-value verdict crossing three
   * layers as an English sentence prefix — restated in `expectedOutput`,
   * re-checked by a guardrail doing `startsWith`, and re-asked up to the retry
   * budget — because a model that wrote `"Confirmed - "` was wrong in a way
   * only prose could describe. A schema makes that a parse.
   *
   * ```ts
   * import { speaker } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const factChecker = speaker({
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
}

/**
 * A {@link SpeakerDef} that declares a {@link SpeakerDef.schema} — what
 * {@link speaker} returns for one, so `ctx.delegate` types `object`.
 *
 * @public
 */
export interface TypedSpeakerDef<T, N extends string = string> extends SpeakerDef<N> {
  schema: StandardSchemaV1<unknown, T>;
}

/**
 * Define a speaker. An identity function, like {@link tool}: it exists for the
 * type (the name inferred as a LITERAL, the schema's output typed), for the name
 * to grep for, and so a speaker is declared at module scope where both a roster
 * and a tool that delegates or hands off to it can import it.
 *
 * @public
 */
export function speaker<const N extends string, S extends StandardSchemaV1>(
  def: SpeakerDef<N> & { schema: S },
): TypedSpeakerDef<InferSchemaOutput<S>, N>;
export function speaker<const N extends string>(def: SpeakerDef<N>): SpeakerDef<N>;
export function speaker(def: SpeakerDef): SpeakerDef {
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
export interface DelegateToolCall {
  /** The tool's name, as the subagent's model called it. */
  name: string;
  /** The arguments it was called with. */
  input: unknown;
}

/**
 * ONE attempt at an answer — what a {@link SpeakerGuardrail} judges.
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
export interface DelegateAnswer {
  /** The subagent's final message — see {@link SpeakerDef.expectedOutput}. */
  text: string;
  /** How many steps this attempt took, including the final answering step. */
  steps: number;
  /** Every tool call this attempt made, in order. */
  toolCalls: readonly DelegateToolCall[];
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
 * Judge one attempt — see {@link SpeakerDef.guardrail}.
 *
 * @public
 */
export type SpeakerGuardrail = (
  answer: DelegateAnswer,
) => GuardrailVerdict | Promise<GuardrailVerdict>;

/**
 * What one delegated run returns: the accepted attempt, plus what getting there
 * took.
 *
 * @sealed
 * @public
 */
export interface DelegateResult extends DelegateAnswer {
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
 * A {@link SpeakerDef.guardrail} that never accepts does not reject either —
 * the run comes back with {@link DelegateResult.accepted} `false`. The two
 * rejections above are both "this delegation could not happen"; a rejected
 * answer is a delegation that happened and produced something, and a caller on
 * a live call can use the difference.
 *
 * @public
 */
export interface TypedDelegateResult<T> extends DelegateResult {
  /**
   * The final message, PARSED against {@link SpeakerDef.schema}.
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
 * that declares a {@link SpeakerDef.schema} answers with the parsed value
 * typed on {@link TypedDelegateResult.object}, and one that does not should not
 * be handed the field at all. Declaring the def through {@link speaker} is
 * what picks the overload — a roster entry stays a plain
 * {@link SpeakerDef}, so a model-chosen delegation is untyped, which is
 * correct: nothing at that call site knows which subagent the model picked.
 *
 * @public
 */
export type DelegateFn = {
  <T>(subagent: TypedSpeakerDef<T>, options: DelegateOptions): Promise<TypedDelegateResult<T>>;
  (subagent: SpeakerDef, options: DelegateOptions): Promise<DelegateResult>;
};
