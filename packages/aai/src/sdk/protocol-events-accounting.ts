// Copyright 2026 the AAI authors. MIT license.
/**
 * The session events about what a session SPENDS, what it REFUSES, and what it
 * CUTS SHORT.
 *
 * Split out of `protocol-events.ts`, which is at the source-length cap: each
 * carries more argument than schema, and each is an addition to a union that
 * reads better as a list of names than as a list of inlined object literals.
 * `SessionEventSchema` names them, so they are ordinary members — same
 * envelope, same retained stream, same `agent({ events })` keys.
 *
 * Why they are a set rather than unrelated frames: each is the observable half
 * of a CONTROL an agent declares. `usage.updated` is what `AgentDef.usageLimits`
 * is measured against, `guardrail.blocked` is what
 * `AgentDef.inputGuardrails`/`outputGuardrails` leave behind, and
 * `user-turn.exceeded` is what `AgentDef.userTurnLimit` leaves behind. A
 * control with no event is a control nobody can audit.
 *
 * @module
 */

import { z } from "zod";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";
import { SessionEventMetaSchema } from "./protocol-event-meta.ts";

/**
 * What this session has spent, as the provider reported it — see
 * `AgentDef.usageLimits`.
 *
 * CUMULATIVE, not per turn: the client (and a `usage.updated` hook) keeps the
 * latest value the way it keeps `state.updated`, so a reader that joined late
 * still sees the true total. A per-turn frame would make every reader
 * re-implement the sum, and get it wrong on resume.
 *
 * **Every model request the runtime makes for the session is in it**, not only
 * the turns: a tool's `ctx.generate` and each step of a `ctx.delegate` run move
 * these numbers too. `AgentDef.usageLimits` lists what is counted and the three
 * things that are not.
 *
 * **Which of those the mode has is the whole rule, and it is not "s2s emits
 * nothing".** The CONVERSATIONAL LOOP reports in pipeline and text modes only —
 * those are the ones this runtime assembles the requests for; in S2S the
 * provider runs the loop inside its own service and reports no token counts to
 * the host, which is why `usageLimits` is refused there rather than enforced
 * against zeroes. `ctx.generate` and `ctx.delegate` are host-side in EVERY
 * mode, and the meter is built per session in every mode, so an S2S agent whose
 * tool generates or delegates can emit this event — its totals then cover those
 * calls and not the conversation around them. **A client must handle the frame
 * in every mode**; what varies is which requests are behind the numbers, never
 * whether the frame can arrive.
 *
 * What decides whether it arrives at all is whether anything READS it: the
 * runtime wires the meter's sink only when the agent declares `usageLimits`, or
 * an `events` handler for `usage.updated` or `"*"`. Measuring is free and always
 * happens; emitting costs a durable event per model step, which an unobserved
 * session should not pay.
 */
export const UsageUpdatedEventSchema = z.object({
  type: z.literal("usage.updated"),
  meta: SessionEventMetaSchema,
  /** Prompt tokens across every request this session has made so far. */
  inputTokens: z.number().int().nonnegative(),
  /** Generated tokens across every request this session has made so far. */
  outputTokens: z.number().int().nonnegative(),
  /**
   * `inputTokens + outputTokens`, and the field a budget is written against.
   *
   * Carried rather than derived because a provider that reports a total which
   * is not the sum of its parts (a reasoning or cache-read line item counted
   * once) is reporting what it billed, and the budget should honour that
   * number rather than a reconstruction of it.
   */
  totalTokens: z.number().int().nonnegative(),
  /** Completed model requests behind those numbers — steps, not turns. */
  steps: z.number().int().nonnegative(),
});
/**
 * A guardrail refused a piece of text — see `AgentDef.inputGuardrails` and
 * `AgentDef.outputGuardrails`.
 *
 * Its own event rather than an `error.reported`, because a block is the
 * feature working: an error frame would put a banner on a screen and, if
 * anyone ever emitted it fatally, hang up a call the guardrail had just saved.
 * What it is for is the audit trail — the one thing an author who ships a
 * safety control needs is a record of every time it fired.
 *
 * The refused text is NOT carried. On the output side that text is precisely
 * what was judged unfit to leave the agent, and putting it in a frame the
 * browser receives would deliver it after all.
 */
export const GuardrailBlockedEventSchema = z.object({
  type: z.literal("guardrail.blocked"),
  meta: SessionEventMetaSchema,
  /** Which side was judged: the caller's words, or the agent's. */
  direction: z.enum(["input", "output"]),
  /** The verdict the guardrail returned, which is also what the agent says. */
  replacement: z.string().max(MAX_TRANSCRIPT_CHARS),
});
/**
 * The caller's turn hit `AgentDef.userTurnLimit` and was ended early — see
 * `UserTurnLimit`.
 *
 * Its own event rather than an `error.reported`, for the reason
 * `guardrail.blocked` is: the cut is the control WORKING, and an error frame
 * would put a banner on a screen for a turn that ended exactly as declared.
 * What it is for is the audit trail — how often callers run into the cap is
 * the one number that says whether it is set right — and, for a UI, the moment
 * to show that the agent is answering what it has heard so far.
 *
 * The turn's text is NOT carried: it arrives as the `user-transcript.committed`
 * that follows, once the transcriber has ended the turn, and a second copy
 * here could disagree with it.
 *
 * Emitted once per utterance, at the moment the cap is crossed — BEFORE the
 * committed transcript, since the commit is the transcriber's answer to the
 * cut. It is emitted whether or not the provider could make the cut; a
 * provider that cannot force an end of turn is logged once as inert.
 */
export const UserTurnExceededEventSchema = z.object({
  type: z.literal("user-turn.exceeded"),
  meta: SessionEventMetaSchema,
  /** Which cap the utterance crossed. */
  limit: z.enum(["words", "duration"]),
  /** Words the transcriber had heard in the turn when the cap fired. */
  words: z.number().int().nonnegative(),
  /** How long the turn had run when the cap fired, in ms from its first word. */
  durationMs: z.number().int().nonnegative(),
});
