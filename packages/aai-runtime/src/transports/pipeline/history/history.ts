// Copyright 2026 the AAI authors. MIT license.
/**
 * Conversation memory for a pipeline session.
 *
 * Keeps two parallel views of the dialogue:
 * - `conversation` — the TOOL-FACING view: what `ctx.messages` hands a tool.
 *   Transcripts as `user`/`assistant` text, plus a `tool` message per settled
 *   tool call ({@link PipelineHistory.pushToolResult}) so a tool can read what
 *   an earlier one answered. Text only: an image part, a reasoning block and a
 *   provider's replay metadata have no string form a tool body would read.
 * - `llm` — Vercel AI SDK {@link ModelMessage}s, the source of truth for what
 *   the model actually sees. Each turn appends `streamText`'s per-step response
 *   messages (the assistant tool-call message AND its `tool` result), so tool
 *   calls and their results carry into the next turn — not just spoken text.
 *
 * **The two are not each other's shape, and a `tool` message may only ever
 * cross from the first to the second by way of a real step message.** In the
 * LLM view a `tool` message is one half of a PAIR — the assistant message
 * carrying the `tool-call` part is the other — and both providers reject a
 * result with no call to answer (which is why {@link evictLlm} cuts only at a
 * message that can lead). The conversation view has no pairs, so {@link PipelineHistory.seed} never maps a
 * resume's `tool` messages across; it takes pairs built from both halves.
 *
 * **The LLM view is re-PAIRED on every write** (`../../../tool-call-pairs.ts`), so
 * `history` itself — not just one request built from it — stays valid.
 *
 * **Neither view is capped by message count, and neither decides what a
 * request SENDS.** That is the token budget's job, done per step in
 * `context-budget.ts` over the whole `llm` view. What bounds the views
 * here is MEMORY: each is retained down to the newest `retainTokens` estimated
 * tokens (`./retention.ts`, default `HISTORY_RETAIN_TOKENS`), a
 * multiple of the largest request budget any model has, so retention can never
 * remove a message a request would have sent. A push records what its own
 * retention evicted, so `dropTrailingUser` can undo the eviction along with the
 * append — see that member's doc for the turn a rollback at the bound used to
 * cost.
 */

import type { Message } from "@alexkroman1/aai";
import { createEpoch, type Epoch } from "@alexkroman1/aai/internal";
import type { ModelMessage } from "ai";
import type { Logger } from "../../../runtime-config.ts";
import { pairToolCallsInPlace } from "../../../tool-call-pairs.ts";
import { toModelMessage } from "../output/index.ts";
import { estimateMessageTokens } from "./context-budget.ts";
import {
  estimateConversationTokens,
  evictBeyondRetention,
  HISTORY_RETAIN_TOKENS,
} from "./retention.ts";

/** Conversation memory handle returned by {@link createPipelineHistory}. */
export interface PipelineHistory {
  /** The tool-facing history — what `ctx.messages` reads. */
  readonly conversation: Message[];
  /** ModelMessage history — what the LLM sees (includes tool calls/results). */
  readonly llm: ModelMessage[];
  /** Append text message(s) to the conversation (tool-facing) view. */
  pushConversation(...msgs: Message[]): void;
  /**
   * Append one settled tool call's result to the conversation view ONLY.
   *
   * Separate from {@link pushConversation} on three counts, each of which is
   * the reason it is not simply that method with a different role:
   *
   * - **It never touches `llm`.** A `tool` message there needs the assistant
   *   `tool-call` message that answers it, and the turn pushes both together
   *   as step messages; a second copy from here would be an orphan result of
   *   exactly the kind {@link evictLlm} refuses to leave at the front.
   * - **It does not bump {@link revision}.** That epoch gates adopting a
   *   preemptive speculation, and what a speculation's request is assembled
   *   from is `llm` — untouched here, so the request in flight is still the
   *   one the real turn would build. Bumping would discard a legitimate
   *   speculation every time a tool finished, which is precisely when one is
   *   in flight (a barge-in during a tool chain).
   * - **It records no {@link PushUndo}.** A rollback pops a trailing USER
   *   message, and a tool result is never one; the slot is CLEARED instead,
   *   under the same "an intervening push spends the slot" rule the pop
   *   follows. A synthetic prompt whose turn produced a tool result therefore
   *   stays in this view — correct, because such a turn left a trace, which is
   *   the same test `persistBargeIn` applies before asking for the rollback.
   *
   * A result written by a turn a barge-in then abandons STAYS, for the reason
   * {@link persistInterruptedTurn} keeps that turn's step messages: the call
   * really ran and really answered, and a later tool told otherwise would ask
   * for it again. A `reset` clears it with everything else.
   */
  pushToolResult(msg: Message): void;
  /**
   * Append ModelMessage(s) — e.g. a turn's response messages — to the LLM view.
   * Answers the messages as STORED (reasoning-cleaned), which is the identity
   * {@link rewrite} matches on.
   */
  pushLlm(...msgs: ModelMessage[]): ModelMessage[];
  /**
   * Replace (or, mapped to `null`, remove) messages this history already
   * holds, matched by IDENTITY — a message since evicted, reset or never held
   * is simply not found. Answers whether anything changed.
   *
   * For the heard-history cut (`heard-history.ts`): a reply that was
   * committed whole and then cut while its audio was still playing.
   */
  rewrite(edits: HistoryRewrite): boolean;
  /**
   * Drop a trailing user message matching `content` from both views.
   *
   * For a SYNTHETIC prompt (false-interruption resume, silence nudge) whose
   * turn was aborted before it produced anything: the prompt is pushed before
   * the LLM stream runs, and nothing else rolls it back, so a resume that a
   * committed user turn mooted left `"…the user did not actually say anything.
   * Continue your reply…"` in history directly ahead of the words the user
   * really said — two consecutive, contradictory user messages, which is an
   * invitation to answer the wrong one. A prompt whose turn DID produce
   * something must stay: the assistant tail persisted beside it answers it.
   *
   * Matched on content rather than trimmed blindly so this can never eat a
   * message it did not write.
   *
   * **It is an INVERSE of the push, which took new state to make true.** Both
   * views are RETAINED to a token bound, so an append at the bound evicts the
   * oldest message; popping the append undid the append and not the eviction it
   * caused, and the rolled-back prompt — a message the caller never said —
   * permanently cost one real conversation turn (found when the bound was a
   * 200-message cap: push at 200 trimmed the front and landed at 200, the pop
   * left 199, and the trimmed message was never restored). So a push records
   * what it evicted ({@link PushUndo}) and a pop that undoes THAT push unshifts
   * it back. Nothing in the system could see the loss — both views
   * are the right shape afterwards, one turn shallower — which is why the claim
   * is now stated as a property over generated depths
   * (`../../../integration/pipeline-history-rollback.integration.test.ts`) rather than at the one depth a
   * unit test picks.
   */
  dropTrailingUser(content: string): void;
  /**
   * Seed both views from resent history (e.g. reconnect/resume).
   *
   * `msgs` seeds the conversation view whole; the LLM view takes `llmMsgs`
   * (`modelHistoryOf`'s real call/result pairs), re-PAIRED like any write, or
   * else `msgs` without its `tool` messages — see the module doc. */
  seed(msgs: readonly Message[], llmMsgs?: readonly ModelMessage[]): void;
  /** Clear both views. */
  reset(): void;
  /**
   * Bumped by every mutator above. The gate on adopting a preemptive
   * speculation (`../speech/speculation.ts`): a speculation is launched against
   * a snapshot of `llm`, and anything that mutates the conversation in between
   * — a chained turn landing, a reset, a reconnect seed — makes the request it
   * is running no longer the request the real turn would assemble. Comparing
   * the revision is the cheap total check; comparing message arrays is not.
   */
  readonly revision: Pick<Epoch, "current" | "isCurrent">;
}

/** Edits for {@link PipelineHistory.rewrite}, per view. */
export interface HistoryRewrite {
  conversation?: ReadonlyMap<Message, Message | null> | undefined;
  llm?: ReadonlyMap<ModelMessage, ModelMessage | null> | undefined;
}

/** Apply one view's identity-matched edits in place; answers whether any hit. */
function applyEdits<T>(arr: T[], edits: ReadonlyMap<T, T | null> | undefined): boolean {
  if (edits === undefined || edits.size === 0) return false;
  let changed = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    const next = edits.get(arr[i] as T);
    if (next === undefined) continue;
    changed = true;
    if (next === null) arr.splice(i, 1);
    else arr[i] = next;
  }
  return changed;
}

/**
 * The marker an interrupted reply's HEARD prefix carries in history, so the
 * model knows it was cut off. One spelling for both writers: the aborted turn
 * body ({@link persistInterruptedTurn}) and the cut of an already-committed
 * reply (`heard-history.ts`).
 */
export function markInterrupted(heard: string): string {
  return `${heard} [interrupted]`;
}

/**
 * Whether a conversation message may be mapped into the LLM view.
 *
 * Only `tool` messages are refused, and the module doc says why: the LLM view
 * holds tool-call PAIRS and this half arrives without the other one.
 * `toModelMessage` would render it as an assistant message — the model would be
 * told it had SAID a tool's serialized output — which is the wrong repair for
 * the right reason.
 */
function isLlmSeedable(m: Message): boolean {
  return m.role !== "tool";
}

/**
 * Retain the LLM view to `retain` tokens, never cutting between a tool-call
 * and its result, ANSWERING what came off the front.
 *
 * The answer is what makes {@link PipelineHistory.dropTrailingUser} an inverse
 * ({@link PushUndo}): `splice`'s own, so the operation that evicts records it.
 *
 * A cut between an assistant `tool-call` message and the `tool` message
 * answering it leaves a result with nothing to answer, which both providers
 * reject outright (OpenAI: "messages with role 'tool' must be a response to a
 * preceding message with 'tool_calls'") — every later turn of the call fails.
 * Turn sizes vary, so cuts drift off turn boundaries on their own. Only the
 * FRONT is cut, so a cut point is simply never a `tool` message.
 */
function evictLlm(arr: ModelMessage[], retain: number): ModelMessage[] {
  return evictBeyondRetention(arr, retain, estimateMessageTokens, (m) => m.role !== "tool");
}

/**
 * A `reasoning` part is worth replaying only if it carries provider metadata
 * that the originating provider needs to reconstruct the turn:
 * - Anthropic thinking blocks (`anthropic.signature`) or redacted thinking
 *   (`anthropic.redactedData`) replay as real `thinking`/`redacted_thinking`.
 * - OpenAI Responses reasoning items (`openai.itemId`, e.g. `rs_...`) are
 *   REQUIRED alongside the message/tool-call items they produced — dropping one
 *   makes the API reject the whole request ("Item 'msg_...' of type 'message'
 *   was provided without its required 'reasoning' item: 'rs_...'").
 *
 * A metadata-less reasoning part is an ephemeral trace with no valid signature;
 * Anthropic warns ("unsupported reasoning metadata") and drops it on replay, so
 * we strip those ourselves rather than re-send them every turn.
 */
function isReplayableReasoning(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): boolean {
  if (!providerOptions) return false;
  const { anthropic, openai } = providerOptions;
  if (anthropic?.signature != null || anthropic?.redactedData != null) return true;
  return openai?.itemId != null;
}

/**
 * Drop non-replayable `reasoning` parts from an assistant message (see
 * {@link isReplayableReasoning}). Reasoning that a provider still needs is kept
 * so multi-turn tool calls survive on the OpenAI Responses API and Anthropic
 * extended thinking. Returns `null` if the message had nothing left to keep.
 */
function withoutReasoning(m: ModelMessage): ModelMessage | null {
  if (m.role !== "assistant" || typeof m.content === "string") return m;
  const content = m.content.filter(
    (part) => part.type !== "reasoning" || isReplayableReasoning(part.providerOptions),
  );
  if (content.length === 0) return null;
  return { ...m, content };
}

/**
 * Persist what an interrupted (barge-in / cancelled) turn produced.
 *
 * Two things must survive the abort: the response messages of every COMPLETED
 * LLM step (assistant tool calls + their `tool` results — dropping them makes
 * the next turn's LLM repeat calls it already made or deny results it already
 * has), and the text the caller actually HEARD, marked `[interrupted]` so the
 * model knows it was cut off. The LLM view only receives the text tail that is
 * not already inside a persisted step message.
 *
 * **`heard` is a prefix of what the model generated, and the difference is
 * deliberate.** This function used to record the whole of `accumulated`, on the
 * reasoning that "the model needs to know what it had committed to saying".
 * That is REVERSED, for two reasons: the caller provably did not hear the tail
 * (TTS runs behind the text, and a barge-in discards everything still in the
 * provider's buffer), and a model reasoning from a record that says it
 * delivered information the caller never got will not repeat it — which is the
 * failure the repetition measurement on `buildTailResumePrompt` describes from
 * the other side. Where the prefix ends is the heard cursor's answer
 * (`../heard/tracker.ts`), the same one the resume prompt's anchor comes from, so
 * the two can never disagree. This is LiveKit's rule.
 *
 * A consequence worth stating: the client's committed transcript for this reply
 * is now deliberately LONGER than the history entry (it still shows everything
 * that reached TTS). That divergence CANNOT be closed by emitting a corrected
 * final — doing so is the measured double-transcript bug below.
 *
 * **Nothing is emitted to the CLIENT here.** This runs when the aborted stream
 * settles, which is necessarily after the barge-in's `cancelled` frame, and the
 * client treats `cancelled` as the end of the reply: aai-ui's handler commits
 * the live agent bubble into the conversation (`commitAgentTranscript`). An
 * `agent_transcript` arriving 1ms later therefore does not amend that message —
 * it opens a NEW live bubble for a reply that is already over, which the next
 * `reply_done`/`cancelled` commits a second time. Measured on tau2-bench
 * retail: 19 of 73 cancels in one run were followed by exactly this frame, so
 * the interrupted reply appeared twice in the transcript — once with the
 * dead-air filler the caller heard, and again in the model-text-only form this
 * function used to send. The client needs no frame from here: every word that
 * reached TTS was already published as an interim `agent_transcript` by
 * `sendTtsText`.
 *
 * Those interim snapshots are not a superset of `heard`, and that is the point:
 * they carry what reached the TTS provider, while the model's own text also
 * includes whatever was still inside the TTS batch coalescer
 * (`createTtsTextCoalescer`) when the abort discarded it. So the client shows
 * what the caller actually heard, where the removed frame replaced it with words
 * that were never synthesized.
 */
export function persistInterruptedTurn(args: {
  history: PipelineHistory;
  /** The prefix of the generated text the caller is estimated to have HEARD. */
  heard: string;
  /** Length of the generated text already covered by persisted step messages. */
  persistedLen: number;
  /** Response messages of the turn's completed steps. */
  stepMessages: readonly ModelMessage[];
  /** Seed the STT provider with the agent's side of the dialog. */
}): void {
  const { history, heard, stepMessages } = args;
  // Pushed unconditionally, BEFORE the empty-heard return: a turn whose tools
  // ran left a real trace even if the caller heard nothing, and dropping the
  // steps would make the next turn re-call tools it already ran.
  if (stepMessages.length > 0) history.pushLlm(...stepMessages);
  // Nothing audible reached the caller — the reply may as well not have
  // happened, so no assistant message is written at all (LiveKit's rule). This
  // also covers a turn that got no further than its dead-air filler: filler is
  // audible but never recordable (see emitText's `record` flag).
  const spoken = heard.trim();
  if (spoken.length === 0) return;
  history.pushConversation({ role: "assistant", content: markInterrupted(spoken) });
  // Clamped: the persisted-step snapshot indexes the GENERATED text, which the
  // heard prefix is shorter than, so an unclamped slice would run past the end
  // (a negative-length tail) rather than yielding nothing.
  const tail = heard.slice(Math.min(args.persistedLen, heard.length)).trim();
  if (tail.length > 0) {
    history.pushLlm({ role: "assistant", content: markInterrupted(tail) });
  }
  // Seeded with the HEARD text, not the generated text: the STT bias is
  // fighting the agent's own voice echoing back, so what was in the air is the
  // right hint. (Judgement call — the fuller text might bias vocabulary
  // better; no measurement either way.)
}

/**
 * What one single-message push evicted, so the pop that undoes that push can
 * put it back.
 *
 * **A push is retained and a pop is not, so without this a rollback is not a
 * rollback.** An append at the bound evicts the oldest message; popping the
 * append leaves the window one message shallower than it was, permanently — see
 * {@link PipelineHistory.dropTrailingUser}, and `../../../integration/pipeline-history-rollback.integration.test.ts`
 * for the property that states it.
 *
 * Three properties, each of which is what keeps a restore from being a
 * corruption:
 *
 * - **One slot PER VIEW.** A turn pushes the user message into `conversation`
 *   and then into `llm` (`../turn-body.ts`), so a single shared slot would
 *   be invalidated by the second half of the pair that fills the first.
 * - **Recorded only for a push of exactly ONE message**, and `null` otherwise.
 *   `dropTrailingUser` pops one message; a two-message push that evicted two
 *   cannot be undone by it, and restoring both would leave the view longer than
 *   it started.
 * - **Consumed by identity**, not by content: the restore happens only when the
 *   message popped IS the message this slot recorded, so an intervening push
 *   (which overwrites the slot) can never have its own eviction unshifted under
 *   a later pop, which would reorder the window.
 */
type PushUndo<T> = { readonly pushed: T; readonly evicted: readonly T[] } | null;

/** Options for {@link createPipelineHistory}. */
export interface PipelineHistoryOptions {
  /** Where a repaired tool pair is reported. */
  log?: Pick<Logger, "warn">;
  sid?: string;
  /**
   * Estimated tokens each view retains (the MEMORY bound, see the module doc);
   * default `HISTORY_RETAIN_TOKENS`. A spec lowers it to reach the bound.
   */
  retainTokens?: number;
}

/** Create a {@link PipelineHistory}, optionally seeded from prior text history. */
export function createPipelineHistory(
  seed?: readonly Message[],
  opts: PipelineHistoryOptions = {},
): PipelineHistory {
  const retain = opts.retainTokens ?? HISTORY_RETAIN_TOKENS;
  const retainText = (arr: Message[]): Message[] =>
    evictBeyondRetention(arr, retain, estimateConversationTokens);
  const retainLlm = (arr: ModelMessage[]): ModelMessage[] => evictLlm(arr, retain);
  const conversation: Message[] = seed ? [...seed] : [];
  // Same subtraction `seed()` below makes, for the same reason — a `tool`
  // message has no half to pair with here.
  const llm: ModelMessage[] = conversation.filter(isLlmSeedable).map(toModelMessage);
  // The existing primitive rather than a hand-rolled counter — see
  // `PipelineHistory.revision`.
  const revision = createEpoch();
  let conversationUndo: PushUndo<Message> = null;
  let llmUndo: PushUndo<ModelMessage> = null;
  const pairLlm = (): void => pairToolCallsInPlace(llm, opts.log, opts.sid);

  /**
   * Pop `content` off the back of `arr` if it is a trailing user message, and
   * restore what that message's own push evicted.
   *
   * The caller clears the slot afterwards WHETHER OR NOT anything was popped: an
   * undo describes one push, and once a pop has looked at it the description is
   * spent — a second pop of the same content must not unshift the same eviction
   * twice, and a slot left standing across an unrelated pop is a window
   * reordered.
   */
  const undoPush = <T extends Message | ModelMessage>(
    arr: T[],
    undo: PushUndo<T>,
    content: string,
  ): void => {
    const last = arr.at(-1);
    if (last === undefined || last.role !== "user" || last.content !== content) return;
    arr.pop();
    // The front of the restored list is whatever sat at index 0 before the push,
    // which `evictLlm`'s invariant says is never a `tool` message — so restoring
    // a healed pair half cannot re-expose an orphan result.
    if (undo?.pushed === last) arr.unshift(...undo.evicted);
  };

  return {
    conversation,
    llm,
    revision: { current: revision.current, isCurrent: revision.isCurrent },
    pushConversation(...msgs: Message[]): void {
      conversation.push(...msgs);
      const evicted = retainText(conversation);
      const pushed = msgs.length === 1 ? msgs[0] : undefined;
      conversationUndo = pushed ? { pushed, evicted } : null;
      revision.bump();
    },
    pushToolResult(msg: Message): void {
      conversation.push(msg);
      retainText(conversation);
      // Spent, not recorded — see the member's doc for all three halves.
      conversationUndo = null;
    },
    pushLlm(...msgs: ModelMessage[]): ModelMessage[] {
      // The message RECORDED is the cleaned one that reached the array, not the
      // argument: `withoutReasoning` may rewrite it, or drop it entirely, and an
      // undo keyed on a message the view does not hold could never be consumed.
      const pushed: ModelMessage[] = [];
      for (const m of msgs) {
        const cleaned = withoutReasoning(m);
        if (cleaned) {
          llm.push(cleaned);
          pushed.push(cleaned);
        }
      }
      pairLlm();
      const evicted = retainLlm(llm);
      const only = pushed.length === 1 ? pushed[0] : undefined;
      llmUndo = only ? { pushed: only, evicted } : null;
      revision.bump();
      return pushed;
    },
    rewrite(edits: HistoryRewrite): boolean {
      const inConversation = applyEdits(conversation, edits.conversation);
      const inLlm = applyEdits(llm, edits.llm);
      if (!(inConversation || inLlm)) return false;
      // An edit that removed an assistant message must not strand its results.
      pairLlm();
      // Spent, like any intervening mutation: a removal shifted the window, so
      // restoring an eviction under a later pop could reorder it.
      conversationUndo = null;
      llmUndo = null;
      revision.bump();
      return true;
    },
    dropTrailingUser(content: string): void {
      undoPush(conversation, conversationUndo, content);
      conversationUndo = null;
      undoPush(llm, llmUndo, content);
      llmUndo = null;
      revision.bump();
    },
    seed(msgs: readonly Message[], llmMsgs?: readonly ModelMessage[]): void {
      if (msgs.length === 0 && !llmMsgs?.length) return;
      conversation.push(...msgs);
      retainText(conversation);
      llm.push(...(llmMsgs ?? msgs.filter(isLlmSeedable).map(toModelMessage)));
      // Paired before retention, as `pushLlm` does: `evictLlm` never splits a pair.
      pairLlm();
      retainLlm(llm);
      // A reconnect seed is never rolled back — nothing pushes a synthetic
      // prompt through this door — and its eviction is therefore not owed back
      // to anybody. Cleared rather than recorded so a stale slot cannot outlive
      // the push it describes.
      conversationUndo = null;
      llmUndo = null;
      revision.bump();
    },
    reset(): void {
      conversation.length = 0;
      llm.length = 0;
      conversationUndo = null;
      llmUndo = null;
      revision.bump();
    },
  };
}
