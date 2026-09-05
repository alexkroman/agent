// Copyright 2026 the AAI authors. MIT license.
/**
 * Conversation memory for a pipeline session.
 *
 * Keeps two parallel views of the dialogue:
 * - `conversation` — text-only {@link Message}s, used for the client protocol,
 *   session resume, and tool context (all of which expect plain text).
 * - `llm` — Vercel AI SDK {@link ModelMessage}s, the source of truth for what
 *   the model actually sees. Each turn appends `streamText`'s per-step response
 *   messages (the assistant tool-call message AND its `tool` result), so tool
 *   calls and their results carry into the next turn — not just spoken text.
 *
 * Both views are capped at `DEFAULT_MAX_HISTORY` (oldest trimmed) — and each
 * push records what its own cap evicted, so `dropTrailingUser` can undo the
 * eviction along with the append. See that member's doc for the turn a rollback
 * at the cap used to cost.
 */

import type { Message } from "@alexkroman1/aai";
import { createEpoch, DEFAULT_MAX_HISTORY, type Epoch } from "@alexkroman1/aai/internal";
import type { ModelMessage } from "ai";
import { toModelMessage } from "./pipeline-stream.ts";

/** Conversation memory handle returned by {@link createPipelineHistory}. */
export interface PipelineHistory {
  /** Text-only history for the client protocol, resume, and tool context. */
  readonly conversation: Message[];
  /** ModelMessage history — what the LLM sees (includes tool calls/results). */
  readonly llm: ModelMessage[];
  /** Append text message(s) to the conversation (client/resume) view. */
  pushConversation(...msgs: Message[]): void;
  /** Append ModelMessage(s) — e.g. a turn's response messages — to the LLM view. */
  pushLlm(...msgs: ModelMessage[]): void;
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
   * views are CAPPED, so an append at `DEFAULT_MAX_HISTORY` trims the oldest
   * message; popping the append undid the append and not the eviction it caused,
   * and the rolled-back prompt — a message the caller never said — permanently
   * cost one real conversation turn: push at 200 trims the front and lands at
   * 200, the pop leaves 199, and the trimmed message was never restored. So a
   * push records what it evicted ({@link PushUndo}) and a pop that undoes THAT
   * push unshifts it back. Nothing in the system could see the loss — both views
   * are the right shape afterwards, one turn shallower — which is why the claim
   * is now stated as a property over generated depths
   * (`pipeline-history-rollback.integration.test.ts`) rather than at the one depth a
   * unit test picks.
   */
  dropTrailingUser(content: string): void;
  /** Seed both views from resent text history (e.g. reconnect/resume). */
  seed(msgs: readonly Message[]): void;
  /** Clear both views. */
  reset(): void;
  /**
   * Bumped by every mutator above. The gate on adopting a preemptive
   * speculation (`pipeline-speculation.ts`): a speculation is launched against
   * a snapshot of `llm`, and anything that mutates the conversation in between
   * — a chained turn landing, a reset, a reconnect seed — makes the request it
   * is running no longer the request the real turn would assemble. Comparing
   * the revision is the cheap total check; comparing message arrays is not.
   */
  readonly revision: Pick<Epoch, "current" | "isCurrent">;
}

/**
 * Trim `arr` to the cap, ANSWERING what came off the front.
 *
 * The return value is what makes {@link PipelineHistory.dropTrailingUser} an
 * inverse — see {@link PushUndo}. It is `splice`'s own answer, so the eviction
 * is recorded by the operation that performs it rather than reconstructed by a
 * caller that would have to know the cap.
 */
function cap<T>(arr: T[]): T[] {
  if (arr.length <= DEFAULT_MAX_HISTORY) return [];
  return arr.splice(0, arr.length - DEFAULT_MAX_HISTORY);
}

/**
 * Cap the LLM view, then heal a tool-call/result pair the trim split.
 *
 * {@link cap} is a pure index trim, and the LLM view — unlike the text-only
 * `conversation` view — holds PAIRS: an assistant message carrying `tool-call`
 * parts followed by the `tool` message carrying their results. When the trim
 * boundary lands between the two, the call is dropped and the result survives
 * with nothing to answer. Both providers reject that outright — OpenAI with
 * "messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'", Anthropic with an unexpected-`tool_result` error — so every
 * turn for the rest of the call fails at the provider and the caller hears
 * `errorPhrase` instead of a reply.
 *
 * Turn sizes vary (a text-only turn is 2 messages, a one-tool turn 4, a tool
 * chain more), so the window drifts out of alignment with turn boundaries on
 * its own; nothing about the conversation has to be unusual. Only the FRONT of
 * the window is trimmed, so a leading `tool` message is the only shape this can
 * produce — dropping those is sufficient, and it costs at most a few messages
 * below the cap.
 */
function capLlm(arr: ModelMessage[]): ModelMessage[] {
  const evicted = cap(arr);
  while (arr.length > 0 && arr[0]?.role === "tool") {
    const shifted = arr.shift();
    if (shifted) evicted.push(shifted);
  }
  // Front order, and the healed pair halves come after the capped ones because
  // that is where they sat: a rollback unshifts this list whole, so the array it
  // restores is byte-for-byte the one the push found.
  return evicted;
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
 * (`pipeline-heard.ts`), the same one the resume prompt's anchor comes from, so
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
  updateAgentContext: (text: string) => void;
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
  history.pushConversation({ role: "assistant", content: `${spoken} [interrupted]` });
  // Clamped: the persisted-step snapshot indexes the GENERATED text, which the
  // heard prefix is shorter than, so an unclamped slice would run past the end
  // (a negative-length tail) rather than yielding nothing.
  const tail = heard.slice(Math.min(args.persistedLen, heard.length)).trim();
  if (tail.length > 0) {
    history.pushLlm({ role: "assistant", content: `${tail} [interrupted]` });
  }
  // Seeded with the HEARD text, not the generated text: the STT bias is
  // fighting the agent's own voice echoing back, so what was in the air is the
  // right hint. (Judgement call — the fuller text might bias vocabulary
  // better; no measurement either way.)
  args.updateAgentContext(spoken);
}

/**
 * What one single-message push evicted, so the pop that undoes that push can
 * put it back.
 *
 * **A push is capped and a pop is not, so without this a rollback is not a
 * rollback.** An append at the cap trims the oldest message; popping the append
 * leaves the window one message shallower than it was, permanently — see
 * {@link PipelineHistory.dropTrailingUser}, and `pipeline-history-rollback.integration.test.ts`
 * for the property that states it.
 *
 * Three properties, each of which is what keeps a restore from being a
 * corruption:
 *
 * - **One slot PER VIEW.** A turn pushes the user message into `conversation`
 *   and then into `llm` (`pipeline-turn-body.ts`), so a single shared slot would
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

/** Create a {@link PipelineHistory}, optionally seeded from prior text history. */
export function createPipelineHistory(seed?: readonly Message[]): PipelineHistory {
  const conversation: Message[] = seed ? [...seed] : [];
  const llm: ModelMessage[] = conversation.map(toModelMessage);
  // The existing primitive rather than a hand-rolled counter — see
  // `PipelineHistory.revision`.
  const revision = createEpoch();
  let conversationUndo: PushUndo<Message> = null;
  let llmUndo: PushUndo<ModelMessage> = null;

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
    // which `capLlm`'s invariant says is never a `tool` message — so restoring a
    // healed pair half cannot re-expose an orphan result.
    if (undo?.pushed === last) arr.unshift(...undo.evicted);
  };

  return {
    conversation,
    llm,
    revision: { current: revision.current, isCurrent: revision.isCurrent },
    pushConversation(...msgs: Message[]): void {
      conversation.push(...msgs);
      const evicted = cap(conversation);
      const pushed = msgs.length === 1 ? msgs[0] : undefined;
      conversationUndo = pushed ? { pushed, evicted } : null;
      revision.bump();
    },
    pushLlm(...msgs: ModelMessage[]): void {
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
      const evicted = capLlm(llm);
      const only = pushed.length === 1 ? pushed[0] : undefined;
      llmUndo = only ? { pushed: only, evicted } : null;
      revision.bump();
    },
    dropTrailingUser(content: string): void {
      undoPush(conversation, conversationUndo, content);
      conversationUndo = null;
      undoPush(llm, llmUndo, content);
      llmUndo = null;
      revision.bump();
    },
    seed(msgs: readonly Message[]): void {
      if (msgs.length === 0) return;
      conversation.push(...msgs);
      cap(conversation);
      llm.push(...msgs.map(toModelMessage));
      capLlm(llm);
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
