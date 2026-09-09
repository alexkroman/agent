// Copyright 2026 the AAI authors. MIT license.
/**
 * The two session events about what a session SPENDS and what it REFUSES.
 *
 * Split out of `protocol-events.ts`, which is at the source-length cap: both
 * carry more argument than schema, and both are additions to a union that reads
 * better as a list of names than as a list of inlined object literals.
 * `SessionEventSchema` names them, so they are ordinary members — same
 * envelope, same retained stream, same `agent({ events })` keys.
 *
 * Why they are a pair rather than two unrelated frames: each is the observable
 * half of a control this SDK gained at the same time. `usage.updated` is what
 * `AgentDef.usageLimits` is measured against, and `guardrail.blocked` is what
 * `AgentDef.inputGuardrails`/`outputGuardrails` leave behind. A control with no
 * event is a control nobody can audit.
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
 * **Pipeline and text modes only, because those are the ones this runtime
 * assembles requests for.** In S2S the provider runs the loop and reports no
 * token counts to the host, so an S2S session emits this event never — which
 * is the honest answer, and the reason `usageLimits` is refused there rather
 * than enforced against zeroes.
 *
 * **Every model request the runtime makes for the session is in it**, not only
 * the turns: a tool's `ctx.generate` and each step of a `ctx.delegate` run move
 * these numbers too. `AgentDef.usageLimits` lists what is counted and the three
 * things that are not.
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
