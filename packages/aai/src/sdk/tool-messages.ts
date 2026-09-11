// Copyright 2026 the AAI authors. MIT license.
/**
 * What a tool SAYS while it runs, and what it says instead of the model when it
 * lands — the declaration half. The pure selection over these (conditions,
 * variants, the delay ladder) is `tool-messages-select.ts`, and the runtime
 * that speaks them is `aai-runtime`'s `tool-messages-runner.ts`.
 *
 * A port of Vapi's tool `messages` design (`ToolMessageStart` /
 * `ToolMessageDelayed` / `ToolMessageComplete` / `ToolMessageFailed`), which is
 * the most complete published version of the idea. Two things are renamed to
 * this repo's conventions and nothing else is: `timingMilliseconds` is
 * {@link ToolDelayedMessage.afterMs} (the spelling `dialog()`'s
 * `timeout: { afterMs }` already uses), and `conditions` is
 * {@link ToolMessageBase.when}.
 *
 * **The four kinds answer two different problems, and only the first is about
 * latency.** START and DELAYED are cover — a lookup that takes four seconds
 * should not sound like a dropped call. COMPLETE and FAILED are about the
 * TURN's shape: a deterministic outcome ("your order shipped Tuesday") does not
 * need a language model to phrase it, and `role: "assistant"` removes an entire
 * LLM round-trip from the turn by saying so.
 *
 * **Filler declared here is never RECORDED**, exactly as the dead-air cover is
 * not (`dead-air-constants.ts`): START and DELAYED reach TTS and the interim
 * caption and stop there. They never enter `ctx.messages`, the model's view, or
 * a committed transcript, and — the property the barge-in gate turns on — they
 * never count as the agent having spoken. See "A filler line may not open the
 * barge-in gate" in `packages/aai-runtime/CLAUDE.md`.
 */

import { z } from "zod";

/**
 * The pool a `start: true` draws from — Vapi's own default filler set, which
 * they publish nowhere but the schema.
 *
 * Five entries because they are VARIANTS: one is drawn per invocation, so an
 * agent whose turn calls three tools does not say "One moment" three times.
 * Deliberately shorter and more neutral than `DEAD_AIR_COVER_PHRASES`, which
 * cover a gap that has already lasted seconds and can afford to acknowledge it
 * ("I'm still checking on this."); a start line is spoken before anything is
 * late, so it must not claim that anything is.
 */
export const DEFAULT_TOOL_START_PHRASES = [
  "Hold on a sec.",
  "One moment.",
  "Just a sec.",
  "Give me a moment.",
  "This'll just take a sec.",
] as const;

/**
 * Ceiling on a blocking start message's delay to the tool call.
 *
 * A `blocking: true` start is the one place a message may hold a tool call up,
 * so the hold is bounded at the CALL SITE rather than by whatever the speech
 * channel does — see `awaitStartSpoken` in `aai-runtime`'s
 * `tool-messages-runner.ts`. Eight seconds is well past any phrase an author
 * would put here (the default pool reads in under two) and well under the tool
 * timeout, so a channel that never settles costs one slow call rather than a
 * wedged turn.
 */
export const TOOL_START_BLOCKING_MAX_MS = 8000;

/**
 * Comparison a {@link ToolMessageCondition} applies. Vapi's six, unchanged.
 *
 * Spelled out as a union rather than derived from the tuple below, which is
 * the direction that reads right on a published type: TypeDoc refuses to
 * document a `typeof CONST[number]` whose constant is not itself published,
 * and publishing a tuple nobody names from an `agent.ts` would fail the root
 * barrel's own membership test. The tuple `satisfies` the union, so an
 * operator added to one and not the other fails to compile.
 */
export type ToolConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

/** The same six as the value `z.enum` needs. @see ToolConditionOperator */
const TOOL_CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
] as const satisfies readonly ToolConditionOperator[];

/**
 * One test a tool call's ARGUMENTS must pass for the message carrying it to be
 * eligible.
 *
 * This is what makes a per-argument-value line possible — a different sentence
 * when looking up an order than when issuing a refund — without splitting one
 * tool into two. Conditions on a message are ANDed; a message with none always
 * matches.
 *
 * `arg` names a top-level argument by the key the model sends. Values compare
 * as JSON scalars: `eq`/`neq` are `Object.is`-style equality, and the four
 * ordering operators apply only when BOTH sides are numbers (a condition that
 * asks to order a string against a number does not match rather than throwing —
 * the model chooses these values, so a comparison it makes nonsense of must not
 * be able to fail a call).
 */
export type ToolMessageCondition = {
  /** The argument's key, as the model sends it. */
  arg: string;
  /** Defaults to `"eq"`. */
  op?: ToolConditionOperator | undefined;
  /** The value to compare against. */
  value: string | number | boolean | null;
};

/**
 * The two fields every message kind carries, as one type for the selector to
 * be generic over (`tool-messages-select.ts`).
 *
 * The three concrete kinds below spell both out rather than intersecting with
 * this, and that is not a style choice: `expectTypeOf(...).toExtend(...)` in
 * `schema-alignment.test.ts` cannot see through an intersection, so a
 * `Base & { … }` shape made the schema/type alignment assertion fail while
 * blaming an unrelated field. Flat declarations keep the gate honest.
 */
export type ToolMessageBase = {
  /** What is spoken, or (for a `system` completion) told to the model. */
  content: string;
  /** Conditions on the call's arguments — see {@link ToolMessageCondition}. */
  when?: ToolMessageCondition[] | undefined;
};

/**
 * Spoken as the tool call BEGINS.
 *
 * Several entries are VARIANTS: one is drawn at random per invocation. Never
 * fires for a call the model made and then abandoned, and never while the
 * caller is talking — see the runner.
 */
export type ToolStartMessage = {
  /** What is spoken. */
  content: string;
  /** Conditions on the call's arguments — see {@link ToolMessageCondition}. */
  when?: ToolMessageCondition[] | undefined;
  /**
   * Hold the tool call until this has been spoken. Defaults to `false`.
   *
   * The honest default, because the alternative charges every call the length
   * of a sentence for a tool that may answer in 80ms. Reach for it when the
   * tool has a side effect the caller should hear about BEFORE it happens
   * ("Okay, I'm cancelling that order now.") — the hold is bounded at eight
   * seconds whatever the line, so a slow speech path costs one slow call and
   * never a wedged turn.
   */
  blocking?: boolean | undefined;
};

/**
 * Spoken when the tool has been running for {@link ToolDelayedMessage.afterMs}.
 *
 * **Same timing means VARIANTS; different timings mean STAGED updates.** Two
 * entries at 3000 are two phrasings of one rung and one of them is drawn; an
 * entry at 3000 and another at 8000 are a ladder — "still checking", then
 * "almost there". That is Vapi's rule verbatim, and it is the whole reason the
 * timing is on the message rather than on the list.
 */
export type ToolDelayedMessage = {
  /** What is spoken. */
  content: string;
  /** Conditions on the call's arguments — see {@link ToolMessageCondition}. */
  when?: ToolMessageCondition[] | undefined;
  /**
   * Milliseconds from the start of the tool call. Rungs fire at their own
   * offset, not one after another, so a ladder of 3000/8000 speaks at 3s and 8s
   * — never at 3s and 11s.
   */
  afterMs: number;
};

/**
 * The role switch, and the reason this feature is worth having.
 *
 * - `"assistant"` — the content IS the reply. It is spoken verbatim and **the
 *   model is not called at all**: the step loop stops at this tool result, so a
 *   deterministic outcome costs zero further LLM round-trips. Exclusive-or, as
 *   Vapi states it — there is no arm where both happen.
 * - `"system"` — the content is a HINT. It rides back with the tool's result as
 *   guidance and the model writes the sentence, which is what an outcome the
 *   agent has to reason about (or apologize for) needs.
 *
 * Defaults to `"assistant"`, because a message worth writing out in full is
 * usually one worth saying.
 */
export type ToolCompletionMessage = {
  /** Spoken verbatim under `role: "assistant"`; told to the model under `"system"`. */
  content: string;
  /** Conditions on the call's arguments — see {@link ToolMessageCondition}. */
  when?: ToolMessageCondition[] | undefined;
  /** Defaults to `"assistant"`. */
  role?: "assistant" | "system" | undefined;
};

/**
 * A tool's messages in NORMALIZED form — what a `ToolSchema` carries and
 * what the runtime reads. Authors write {@link ToolMessagesInput}, which
 * `agentToolsToSchemas` normalizes into this.
 */
export type ToolMessages = {
  /** Spoken as the call begins — see {@link ToolStartMessage}. */
  start?: ToolStartMessage[] | undefined;
  /** The delay ladder — see {@link ToolDelayedMessage}. */
  delayed?: ToolDelayedMessage[] | undefined;
  /** What a settled call says — see {@link ToolCompletionMessage}. */
  complete?: ToolCompletionMessage[] | undefined;
  /**
   * What a FAILED call says — a tool that returned a `ToolFailure`, or one
   * whose throw the runtime serialized into one. The same role switch:
   * `"system"` is what lets the model produce an error-aware reply instead of a
   * canned one, which is almost always the better answer for a failure.
   */
  failed?: ToolCompletionMessage[] | undefined;
};

/**
 * What an author writes for `tool({ messages })` — every kind also accepts the
 * shorthands, because the common declaration is one string.
 *
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Look up an order",
 *   inputSchema: z.object({ orderId: z.string() }),
 *   messages: {
 *     start: true, // the default filler pool, one drawn per call
 *     delayed: [
 *       { afterMs: 3000, content: "Still pulling that up." },
 *       { afterMs: 3000, content: "Bear with me one second." },
 *       { afterMs: 8000, content: "Sorry — this one is taking a while." },
 *     ],
 *     failed: [{ role: "system", content: "The order service is down. Offer a callback." }],
 *   },
 *   execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
 * });
 * ```
 */
export type ToolMessagesInput = {
  /** `true` draws one of the five default hold lines per invocation. */
  start?: boolean | string | readonly (string | ToolStartMessage)[];
  /** No shorthand: a rung without its `afterMs` is not a rung. */
  delayed?: readonly ToolDelayedMessage[];
  /** A bare string is `{ role: "assistant", content }`. */
  complete?: string | readonly (string | ToolCompletionMessage)[];
  /** A bare string is `{ role: "assistant", content }`. */
  failed?: string | readonly (string | ToolCompletionMessage)[];
};

const ToolMessageConditionSchema = z.object({
  arg: z.string().min(1),
  op: z.enum(TOOL_CONDITION_OPERATORS).optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const baseMessageShape = {
  content: z.string().min(1),
  when: z.array(ToolMessageConditionSchema).optional(),
};

/** @internal Zod for the NORMALIZED {@link ToolMessages}. */
export const ToolMessagesSchema = z.object({
  start: z.array(z.object({ ...baseMessageShape, blocking: z.boolean().optional() })).optional(),
  delayed: z
    .array(z.object({ ...baseMessageShape, afterMs: z.number().int().nonnegative() }))
    .optional(),
  complete: z
    .array(z.object({ ...baseMessageShape, role: z.enum(["assistant", "system"]).optional() }))
    .optional(),
  failed: z
    .array(z.object({ ...baseMessageShape, role: z.enum(["assistant", "system"]).optional() }))
    .optional(),
});

function startList(input: ToolMessagesInput["start"]): ToolStartMessage[] | undefined {
  if (input === undefined || input === false) return undefined;
  if (input === true) return DEFAULT_TOOL_START_PHRASES.map((content) => ({ content }));
  const entries = typeof input === "string" ? [input] : input;
  const out = entries.map((e) => (typeof e === "string" ? { content: e } : { ...e }));
  return out.length > 0 ? out : undefined;
}

function completionList(
  input: string | readonly (string | ToolCompletionMessage)[] | undefined,
): ToolCompletionMessage[] | undefined {
  if (input === undefined) return undefined;
  const entries = typeof input === "string" ? [input] : input;
  const out = entries.map((e) => (typeof e === "string" ? { content: e } : { ...e }));
  return out.length > 0 ? out : undefined;
}

/**
 * Author input → the wire shape, dropping every kind the tool did not declare.
 *
 * Answers `undefined` for a tool with nothing to say, so a schema for an
 * ordinary tool is byte-identical to what it was before this field existed —
 * which is what keeps `messages` off every deployed agent's tool declarations
 * and out of every snapshot that did not opt in.
 */
export function normalizeToolMessages(
  input: ToolMessagesInput | undefined,
): ToolMessages | undefined {
  if (input === undefined) return undefined;
  const start = startList(input.start);
  const delayed = input.delayed === undefined ? undefined : input.delayed.map((m) => ({ ...m }));
  const complete = completionList(input.complete);
  const failed = completionList(input.failed);
  const out: ToolMessages = {};
  if (start !== undefined) out.start = start;
  if (delayed !== undefined && delayed.length > 0) out.delayed = delayed;
  if (complete !== undefined) out.complete = complete;
  if (failed !== undefined) out.failed = failed;
  return Object.keys(out).length > 0 ? out : undefined;
}
