// Copyright 2026 the AAI authors. MIT license.
/**
 * A HANDOFF runs when the caller asked for a person — or asked again.
 *
 * A transfer ends the agent's part of the call, so every change it had left to
 * make is lost. The prompt already says to transfer only when the caller asks
 * for a person or has turned down every allowed option, and the model breaks
 * it: on tau2-bench retail, sims that transferred passed 17% of the time
 * against 69% for those that did not, and 20 of 24 transfers were in failed
 * sims — after one failed lookup ("Isn't there another way to look me up?"),
 * after a caller declined a refund method, or before any lookup at all.
 *
 * So the check is made here, in code: a tool declared `effect: "handoff"` runs
 * only if one of the caller's last {@link ASKED_WINDOW} turns asks for a
 * person, or the model already had one refused and the caller has spoken
 * since (they are still there, and the model still wants to hand off — the
 * gate asks once, it does not hold the call hostage). Otherwise the model is
 * told the transfer was NOT made and how to keep helping.
 *
 * **The model cannot be trusted to apply the conditions itself.** A refusal
 * that listed them and said "call again if one holds" was replayed at each of
 * the 24 recorded transfers: the model re-called on only 2 of 12 samples at
 * the 4 transfers the task expected, though in 3 of those the caller had just
 * asked for "someone who can actually fix this" — and twice answered as if
 * transferred. Matched in code instead, the expected transfers ran 9 of 12 and
 * the unwanted ones fell from 22 of 60 to the 9 where the caller had asked.
 *
 * The person-request match is an English phrase list: an agent in another
 * language still gets the ask-again path, just not the immediate one.
 * Content-blind otherwise. The refusal is an ordinary result, not an
 * `Error…`, so the failed-call memo does not refuse the second attempt.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { Logger } from "../logger.ts";

/** How many of the caller's latest turns are searched for a person request. @internal */
export const ASKED_WINDOW = 2;

/** A caller turn asking for a person. English only — see the module doc. @internal */
export const ASKED_FOR_PERSON: RegExp =
  /\b(human|person|someone|somebody|agent|representative|manager|supervisor|operator|transfer|escalate)\b/i;

/** @internal */
export const HANDOFF_NOT_MADE_RESULT: string =
  "TRANSFER NOT MADE. The caller is still on the line with you and nothing was handed off. " +
  "A transfer ends the call, and the caller has not asked for a person, so first: if a lookup " +
  "of the caller failed, have them spell what failed and send exactly that spelling; if part " +
  "of the request is blocked, offer the allowed option as something you can do now. Don't " +
  "mention this check. If the caller then asks for a person or turns down every allowed " +
  "option, call this tool again.";

/** Names of the tools a declaration marks as handoffs. @internal */
export function handoffToolNames(schemas: readonly ToolSchema[]): ReadonlySet<string> {
  return new Set(schemas.filter((s) => s.effect === "handoff").map((s) => s.name));
}

function callerTurns(messages: readonly Message[] | undefined): string[] {
  return (messages ?? []).filter((m) => m.role === "user").map((m) => m.content);
}

/**
 * Wrap `executeTool` so a declared handoff runs only on a caller's request, or
 * on a second attempt after the caller spoke again. With no declared handoffs
 * it returns `executeTool` itself.
 *
 * @internal
 */
export function withHandoffGate(
  executeTool: ExecuteTool,
  deps: { schemas: readonly ToolSchema[]; log: Logger; sid: string },
): ExecuteTool {
  const handoffs = handoffToolNames(deps.schemas);
  if (handoffs.size === 0) return executeTool;
  /** Caller turns heard when a handoff was last refused; `undefined` before any. */
  let refusedAt: number | undefined;
  return (name, args, sessionId, messages, options) => {
    if (!handoffs.has(name)) return executeTool(name, args, sessionId, messages, options);
    const turns = callerTurns(messages);
    const asked = turns.slice(-ASKED_WINDOW).some((t) => ASKED_FOR_PERSON.test(t));
    const askedAgain = refusedAt !== undefined && turns.length > refusedAt;
    if (asked || askedAgain) return executeTool(name, args, sessionId, messages, options);
    refusedAt = turns.length;
    deps.log.info("Pipeline handoff refused: the caller has not asked for a person", {
      sid: deps.sid,
      tool: name,
    });
    return Promise.resolve(HANDOFF_NOT_MADE_RESULT);
  };
}
