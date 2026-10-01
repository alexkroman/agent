// Copyright 2026 the AAI authors. MIT license.
/**
 * What one STEP is allowed to send the model, in tokens — the ONLY bound on a
 * request.
 *
 * A message count says nothing about size, and the two do not correlate: a
 * text-only turn is a sentence, and a tool result carrying an agent's whole
 * mutable state is ~106 KB — the `retail-orders-agent` template writes one on
 * nearly every tool call. Two hundred of those (the message cap this replaced)
 * is an order of magnitude past any model's context window, and the failure
 * lands mid-call, at the provider, on a live voice session: every remaining
 * turn fails and the caller hears `errorPhrase` instead of a reply.
 *
 * **This trims the REQUEST, never the record.** It is a `prepareStep`
 * preparer — the AI SDK's own per-step hook, whose `messages` override is
 * documented as "the messages that will be sent to the model for the current
 * step" — so `PipelineHistory` keeps everything and only what crosses to the
 * provider is bounded. That matters because the same history is replayed to the
 * client, persisted for resume, and handed to tools as `ctx.messages`: a trim
 * inside the history destroys all four to fix one. The history's own MEMORY
 * bound (`./retention.ts`) is in tokens too, and is sized at a
 * multiple of {@link LARGEST_CONTEXT_TOKEN_BUDGET} so that it can never reach
 * into what this module would send.
 *
 * **The count is CALIBRATED against the provider's own number, not merely
 * estimated.** Every completed step carries `usage.inputTokens` — the measured
 * input cost of the exact message set that step sent — so after one step the
 * true cost of a known message prefix is known, and only what has been appended
 * since needs estimating. The difference between that measurement and this
 * module's estimate of the same prefix is the FIXED cost the estimator
 * structurally cannot see: the system prompt and the tool declarations, neither
 * of which is in the message list, plus whatever the estimator is biased by on
 * this conversation. That difference is what {@link createContextBudget}
 * carries forward, and it is carried across TURNS as well as steps, because the
 * system prompt and the tool schemas are the same on the next turn.
 *
 * **The window comes from the model, and an unknown one is budgeted as the
 * SMALLEST window the catalog carries.** {@link ASSEMBLYAI_GATEWAY_MODELS} is
 * the only per-model context window this repo carries; an author-supplied
 * provider, a custom `registerLlmKind`, or an id the gateway does not advertise
 * resolves to `undefined` in {@link modelContextTokens}, and
 * {@link contextTokenBudget} then budgets against
 * {@link UNKNOWN_MODEL_CONTEXT_TOKENS}. That is a guess, and the direction is
 * chosen: there is no other bound on a request any more (the 200-message cap
 * that used to be the fallback is gone), so declining to guess would send an
 * unknown model the whole conversation. Too large fails at the provider, which
 * is the bug this module exists for; the smallest known window (32k today)
 * holds hundreds of spoken turns, which is more than the message cap ever
 * kept, so "too small" costs only the far end of a very long call.
 *
 * The lookup is by model ID alone and deliberately not by provider kind: a
 * window is a property of the model, so `openai({ model: "gpt-5.1" })` and the
 * gateway's `"gpt-5.1"` are the same model and take the same number.
 */

import { ASSEMBLYAI_GATEWAY_MODELS } from "@alexkroman1/aai/host-internal";
import type { LanguageModel, ModelMessage } from "ai";
import { estimateTokenCount } from "tokenx";
import type { Logger } from "../../../runtime-config.ts";

/**
 * Share of the model's context window NOT spendable on the message list.
 *
 * History is not the only thing in a request. The system prompt, the tool
 * DECLARATIONS (every tool's name, description and JSON Schema, re-sent on
 * every step of every turn) and the model's own output all come out of the same
 * window, and the first two are absent from the message list this budget
 * measures until a step has been measured. Spend 100% of the window and the
 * request is over budget the moment it is assembled — the failure this module
 * exists to prevent, moved one layer along rather than fixed.
 *
 * A FRACTION rather than a measured reserve, and that is a judgement. The
 * output half is not measurable in advance at all — the reply has not been
 * generated — and the first request of a session has no measured step behind it
 * to learn the other two from. A quarter of the window is generous against what
 * a voice agent carries (a long system prompt plus a dozen tools is single-digit
 * thousands of tokens, against 50,000 reserved on a 200k model), and generous is
 * the cheap direction: unspent headroom costs a few turns of context at the far
 * end of a long call, where overspending costs the call.
 *
 * Once a step HAS been measured the accounting is strictly more conservative
 * than this, never less: the measured overhead counts the system prompt and the
 * tool schemas a second time, inside a budget that already reserved for them.
 */
export const CONTEXT_WINDOW_RESERVE = 0.25;

/**
 * Tokens charged to a message on top of its text.
 *
 * Every message is framed by the provider — a role, and the delimiters around
 * it — and that framing is billed. Four is the figure OpenAI's own cookbook
 * counter uses per message and what Mastra's token limiter charges (3.8,
 * rounded). The exact number matters little here, since the calibration below
 * absorbs a systematic error; charging SOMETHING matters, because without it a
 * history of many short messages reads as very nearly free.
 */
export const MESSAGE_TOKEN_OVERHEAD = 4;

/**
 * Per-message estimates, keyed by the message OBJECT.
 *
 * A message is measured on every step of every turn for the rest of the call,
 * so without this the trim is quadratic in the number of messages and linear in
 * the size of each — and the messages that make this budget necessary at all
 * are the ~106 KB ones. Keyed by identity because the AI SDK hands the same
 * message objects back on each step, and because a rewritten message
 * (`withoutReasoning`) is a different object and must not be answered from the
 * original's entry.
 */
const estimates = new WeakMap<ModelMessage, number>();

/** The text a message contributes — its content, framed as the provider sends it. */
function messageText(message: ModelMessage): string {
  const { content } = message;
  // A parts array is sent as JSON, so its structure is billed along with its
  // text; stringifying it is a closer proxy than concatenating the text parts,
  // and is the only way a tool result — which is almost entirely structure — is
  // counted at all.
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Estimated tokens for one message, memoized on the message.
 *
 * `tokenx` is a heuristic (no BPE encoder, no wasm, no dependencies) and this
 * is treated as an estimate: the reserve above bounds its error, and the
 * calibration below corrects its level against what the provider actually
 * charged. Nothing here is reported to anybody as a token count.
 */
export function estimateMessageTokens(message: ModelMessage): number {
  const cached = estimates.get(message);
  if (cached !== undefined) return cached;
  const estimate = estimateTokenCount(message.role + messageText(message)) + MESSAGE_TOKEN_OVERHEAD;
  estimates.set(message, estimate);
  return estimate;
}

/** Model id → advertised context window, for the ids this repo knows one for. */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map(
  Object.entries(ASSEMBLYAI_GATEWAY_MODELS).map(([id, info]) => [id, info.context]),
);

/**
 * The window an unknown model is budgeted against: the SMALLEST the catalog
 * carries, derived rather than written down so a regenerated catalog moves it.
 * See the module doc for why an unknown window is guessed at all.
 */
export const UNKNOWN_MODEL_CONTEXT_TOKENS = Math.min(...CONTEXT_WINDOWS.values());

/** The message budget a window of `context` tokens leaves after the reserve. */
const budgetOf = (context: number): number => Math.floor(context * (1 - CONTEXT_WINDOW_RESERVE));

/**
 * The largest message budget any model can be given — the bound the history's
 * memory retention is sized against (`./retention.ts`), so that
 * retention can never reach into a request this module would send.
 */
export const LARGEST_CONTEXT_TOKEN_BUDGET = budgetOf(Math.max(...CONTEXT_WINDOWS.values()));

/**
 * The model's advertised context window in tokens, or `undefined` when the
 * catalog does not carry it. {@link contextTokenBudget} decides what an
 * unknown window is budgeted as; this answers only what is KNOWN.
 */
export function modelContextTokens(llm: LanguageModel): number | undefined {
  const id = typeof llm === "string" ? llm : llm.modelId;
  return CONTEXT_WINDOWS.get(id);
}

/**
 * Tokens one step's message list may occupy for this model — against its own
 * window when the catalog knows it, against {@link UNKNOWN_MODEL_CONTEXT_TOKENS}
 * when it does not. Never more than {@link LARGEST_CONTEXT_TOKEN_BUDGET}.
 */
export function contextTokenBudget(llm: LanguageModel): number {
  return budgetOf(modelContextTokens(llm) ?? UNKNOWN_MODEL_CONTEXT_TOKENS);
}

/**
 * Drop oldest messages until the list fits `limit`, then heal a tool pair the
 * cut split.
 *
 * Two invariants, both of them the difference between a trim and an outage:
 *
 * - **A tool-call/result pair goes whole or not at all.** The list holds PAIRS
 *   — an assistant message carrying `tool-call` parts followed by the `tool`
 *   message carrying their results — and a cut between the two leaves a result
 *   with nothing to answer. Both providers reject that outright (OpenAI:
 *   "messages with role 'tool' must be a response to a preceding message with
 *   'tool_calls'"; Anthropic: an unexpected-`tool_result` error), so a split
 *   pair does not degrade the reply, it fails the request. Only the FRONT is
 *   cut, so a leading `tool` message is the only shape this can produce, and
 *   dropping those is sufficient — at a cost of at most a few messages.
 * - **At least ONE message survives**, however far over budget it is. An empty
 *   message list is a provider error, and the message left standing is the one
 *   the caller just said, so dropping it answers nothing. A single message over
 *   budget is therefore still sent, and still fails at the provider — the
 *   honest outcome, since nothing this side can make a 300 KB tool result fit a
 *   32k window.
 *
 * `overhead` is the measured fixed cost (system prompt + tool declarations +
 * estimator bias) when a step has been measured, and `0` before that.
 */
export function trimToTokenBudget(
  messages: readonly ModelMessage[],
  limit: number,
  overhead: number,
): ModelMessage[] {
  let total = overhead;
  for (const message of messages) total += estimateMessageTokens(message);
  let start = 0;
  while (total > limit && start < messages.length - 1) {
    const dropped = messages[start];
    if (!dropped) break;
    total -= estimateMessageTokens(dropped);
    start++;
  }
  while (start < messages.length - 1 && messages[start]?.role === "tool") start++;
  return messages.slice(start);
}

/** Everything {@link createContextBudget} needs. */
export interface ContextBudgetOptions {
  /** The turn's model — its advertised window is the budget. */
  llm: LanguageModel;
  log: Logger;
  sid: string;
}

/**
 * The slice of `prepareStep`'s options this preparer READS.
 *
 * Declared rather than taking the SDK's whole option bag, for two reasons. It
 * says in the type what the trim is a function of — the step index, the
 * measured usage of the steps behind it, and the list about to be sent — and a
 * narrower parameter is a SUPERTYPE, so a {@link ContextBudgetPreparer} is
 * still assignable to `PrepareStepFunction` and still composes; `forceFinalAnswer`
 * has always been declared this way for the same reason. What it buys the specs
 * is that a case constructs the three fields it is about rather than a
 * thirteen-field fixture of which ten decide nothing.
 */
export interface ContextBudgetStep {
  /** Index of the step being prepared; `0` starts a new `streamText` call. */
  stepNumber: number;
  /** The steps already completed by THIS call, newest last. */
  steps: readonly { readonly usage: { readonly inputTokens: number | undefined } }[];
  /** The list that will be sent unless this returns an override. */
  messages: ModelMessage[];
}

/** What {@link createContextBudget} returns — a `prepareStep` preparer. */
export type ContextBudgetPreparer = (
  step: ContextBudgetStep,
) => { messages: ModelMessage[] } | undefined;

/**
 * A `prepareStep` preparer that bounds what each step sends, learning the
 * request's fixed cost from the provider as it goes.
 *
 * **Created once per SESSION, not once per turn**, which is the whole value of
 * the calibration: the system prompt and the tool schemas are the same on every
 * turn, so the overhead learned on turn 1's last step is the right number for
 * turn 2's FIRST step — the step that would otherwise be estimated blind, and
 * the only step most turns have (p50 is one). A per-turn preparer would throw
 * that away and re-learn it after every reply.
 *
 * What resets per turn is the prefix bookkeeping, since the message list a new
 * `streamText` call starts from is not the one the last call ended with.
 */
export function createContextBudget(options: ContextBudgetOptions): ContextBudgetPreparer {
  // Always a number — an unknown window is budgeted too, see the module doc.
  const limit = contextTokenBudget(options.llm);
  const { log, sid } = options;
  /**
   * Measured fixed cost of a request beyond its messages, or `undefined` until
   * a step reports one. Session-scoped; see this function's doc.
   */
  let overhead: number | undefined;
  /**
   * The message list handed to the model on the previous step of the CURRENT
   * `streamText` call: its length, and its last element, which is what lets the
   * next invocation prove the list it is looking at really extends that one.
   */
  let sent: { count: number; tail: ModelMessage | undefined } | undefined;

  return ({ stepNumber, steps, messages }) => {
    // A new `streamText` call. The previous call's prefix says nothing about
    // this one's list, though its measured OVERHEAD still does.
    if (stepNumber === 0) sent = undefined;
    // `usage.inputTokens` is the provider's count for the exact list the last
    // step sent, which is the list recorded in `sent`. Both halves are
    // conditional and neither is a defect: a provider need not report usage at
    // all, and the identity check is what refuses a stale prefix (an override
    // is documented to carry forward, so the current list should extend the
    // recorded one — if it does not, this module's model of the loop is wrong
    // and the safe move is to fall back to estimating everything).
    const measured = steps.at(-1)?.usage.inputTokens;
    if (measured !== undefined && sent !== undefined && extendsPrefix(messages, sent)) {
      let estimated = 0;
      for (let i = 0; i < sent.count; i++) {
        const message = messages[i];
        if (message) estimated += estimateMessageTokens(message);
      }
      // Clamped at zero: an estimator that over-counted the prefix would
      // otherwise CREDIT the request, and a negative overhead is a discount on
      // a window that does not give discounts.
      overhead = Math.max(0, measured - estimated);
    }
    const trimmed = trimToTokenBudget(messages, limit, overhead ?? 0);
    sent = { count: trimmed.length, tail: trimmed.at(-1) };
    if (trimmed.length === messages.length) return;
    log.info("context budget: trimming the messages sent this step", {
      limit,
      overhead,
      dropped: messages.length - trimmed.length,
      kept: trimmed.length,
      calibrated: overhead !== undefined,
      sid,
    });
    return { messages: trimmed };
  };
}

/** Does `messages` still begin with the list recorded in `sent`? */
function extendsPrefix(
  messages: readonly ModelMessage[],
  sent: { count: number; tail: ModelMessage | undefined },
): boolean {
  if (messages.length < sent.count) return false;
  return messages[sent.count - 1] === sent.tail;
}
