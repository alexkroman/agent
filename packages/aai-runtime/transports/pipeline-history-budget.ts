// Copyright 2026 the AAI authors. MIT license.
/**
 * What the LLM view of a session's history is allowed to COST, in tokens.
 *
 * The message cap this sits beside (`DEFAULT_MAX_HISTORY`, 200) bounds the
 * number of messages and says nothing about their size, and the two do not
 * correlate: a text-only turn is a sentence, and a tool result carrying an
 * agent's whole mutable state is ~106 KB — the `retail` template writes one on
 * nearly every tool call. Two hundred of those is an order of magnitude past
 * any model's context window, and the failure lands mid-call, at the provider,
 * on a live voice session: every remaining turn fails and the caller hears
 * `errorPhrase` instead of a reply.
 *
 * So the token budget is the PRIMARY constraint and the message cap is the
 * secondary one — a belt-and-braces bound on unbounded growth that costs
 * nothing to keep and needs no model to evaluate.
 *
 * **The window comes from the model, and when it is unknown we do not guess.**
 * {@link ASSEMBLYAI_GATEWAY_MODELS} is the only per-model context window this
 * repo carries; an author-supplied provider, a custom `registerLlmKind`, or any
 * model id the gateway does not advertise resolves to `undefined`, and
 * `historyTokenBudget` answers `undefined` in turn. A caller that gets
 * `undefined` trims by MESSAGE COUNT exactly as it did before — the behaviour
 * this replaces, kept as the fallback rather than a guessed window, because a
 * guess that is too large fails at the provider (the bug) and one that is too
 * small silently amputates a working conversation.
 *
 * The lookup is by model ID alone and deliberately not by provider kind: a
 * window is a property of the model, so `openai({ model: "gpt-5.1" })` and the
 * gateway's `"gpt-5.1"` are the same model and take the same number. An id the
 * table does not hold falls back, which is the safe direction.
 */

import { ASSEMBLYAI_GATEWAY_MODELS } from "@alexkroman1/aai/host-internal";
import type { LanguageModel, ModelMessage } from "ai";
import { estimateTokenCount } from "tokenx";

/**
 * Share of the model's context window NOT spendable on conversation history.
 *
 * History is not the only thing in a request. The system prompt, the tool
 * DECLARATIONS (every tool's name, description and JSON Schema, re-sent on
 * every step of every turn) and the model's own output all come out of the same
 * window, and none of them is in the message list this budget measures. Spend
 * 100% of the window on history and the request is over budget the moment it is
 * assembled — which is the failure this module exists to prevent, moved one
 * layer along rather than fixed.
 *
 * A FRACTION rather than a measured reserve, and that is a judgement:
 * the declarations' serialized size is the provider adapter's business rather
 * than ours, and the length of a reply that has not been generated is not
 * knowable at all, so a measured reserve would be two estimates and a guess.
 * A quarter of the window is generous against what a voice agent actually
 * carries — a long system prompt plus a dozen tools is single-digit thousands
 * of tokens, against 50,000 reserved on a 200k model — and being generous is
 * the cheap direction: unspent headroom costs a few turns of history at the far
 * end of a long call, where overspending costs the call.
 */
export const HISTORY_CONTEXT_RESERVE = 0.25;

/**
 * Tokens charged to a message on top of its text.
 *
 * Every message is framed by the provider — a role, and the delimiters around
 * it — and that framing is billed. Four is the figure the OpenAI cookbook's own
 * counter uses per message and is what Mastra's token limiter charges (3.8,
 * rounded); the exact number matters far less than charging SOMETHING, since
 * without it a history of many short messages reads as nearly free.
 */
export const MESSAGE_TOKEN_OVERHEAD = 4;

/**
 * Per-message estimates, keyed by the message OBJECT.
 *
 * A message is pushed once and then re-measured on every later push for the
 * rest of the call, so without this the trim is quadratic in the number of
 * messages and linear in the size of each — and the messages that make this
 * budget necessary at all are the ~106 KB ones. Keyed by identity because the
 * view holds messages by identity: `withoutReasoning` rewrites a message into a
 * NEW object before it is pushed, so a rewritten message is a different key and
 * cannot be answered from the original's entry.
 */
const estimates = new WeakMap<ModelMessage, number>();

/** The text a message contributes — its content, framed as the provider sends it. */
function messageText(message: ModelMessage): string {
  const { content } = message;
  // A parts array is sent as JSON, so its structure is billed along with its
  // text; stringifying it is a closer proxy than concatenating the text parts
  // and is the only way a tool result — which is entirely structure — is
  // counted at all.
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Estimated tokens for one message, memoized on the message.
 *
 * `tokenx` is a heuristic (no BPE encoder, no wasm), so this is an ESTIMATE and
 * is treated as one: the reserve above is what absorbs the error, and nothing
 * here is reported to anybody as a token count.
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
 * The model's context window in tokens, or `undefined` when it is not known.
 *
 * See the module doc: unknown is answered as unknown, never as a default.
 */
export function modelContextTokens(llm: LanguageModel): number | undefined {
  const id = typeof llm === "string" ? llm : llm.modelId;
  return CONTEXT_WINDOWS.get(id);
}

/**
 * Tokens the LLM history view may occupy for this model, or `undefined` when
 * the model's window is unknown and the caller should trim by message count.
 */
export function historyTokenBudget(llm: LanguageModel): number | undefined {
  const context = modelContextTokens(llm);
  if (context === undefined) return undefined;
  return Math.floor(context * (1 - HISTORY_CONTEXT_RESERVE));
}
