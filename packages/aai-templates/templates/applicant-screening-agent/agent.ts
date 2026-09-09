import { agent } from "@alexkroman1/aai";
import { hiringProjection } from "./shared.ts";

/**
 * A hiring desk you can phone: CrewAI's `lead-score-flow`, with the hiring
 * manager on the line instead of at a terminal.
 *
 * **It is the port of the most complex example CrewAI ships**, and `crews.ts`
 * carries the attribution and the table mapping their pieces onto ours. Two
 * crews score a stack of applicants against a role and write every one of
 * them an email; a `Flow` with a cyclic `@router` puts a human between the two,
 * reading the top three and choosing to re-score with feedback, proceed, or
 * quit. That router is a blocking `input()` with three numbered options — the
 * most voice-shaped code in the repository — and here the three options are
 * three things the caller can say.
 *
 * **The two crews become two different SDK primitives, and the split is the
 * lesson.** The evaluator's output is a Pydantic shape, so it is
 * `ctx.generate({ schema })`, twelve calls through a bounded window; the
 * coordinator's output is an email with rules no schema holds, so it is a
 * `subagent()` with `expectedOutput` and a `guardrail`. Which one a crew task
 * becomes is decided by what it produces, not by what it is called.
 *
 * **Three things a phone changed**, each argued where it lives: the feedback
 * loop is BOUNDED (`shared.ts`, `MAX_FEEDBACK_ROUNDS`), the shortlist can be
 * spoken rather than fixed to the top three (`tools/proceed_to_emails.ts`), and
 * the drafts live in the session for the desk to read back rather than in a
 * folder on disk (`tools/read_email.ts`).
 */
export default agent({
  name: "Hiring Desk",
  description:
    "Screens a stack of applicants against a role and drafts each of them a follow-up email",
  /**
   * A ceiling on what one hiring call may spend.
   *
   * **This is the template where a budget has to cover DELEGATION, and until
   * the meter did, it could not.** Almost nothing this desk spends is spent in
   * the conversation: one screening round is twelve `ctx.generate({ schema })`
   * calls through `scoreCandidates`, the caller may ask for up to
   * `MAX_FEEDBACK_ROUNDS` more (`shared.ts`), and `proceed_to_emails` then runs twelve
   * `ctx.delegate` subagents — each a full tool loop with a guardrail that may
   * send an answer back. A cap that counted only the turns would bound the
   * cheapest part of the call while reading as though it bounded the call;
   * `UsageLimits` says which calls count, and all of the above do.
   *
   * The number is an ORDER OF MAGNITUDE rather than a measurement — nobody has
   * run this against a real model and totalled it. It is sized from the shape:
   * four scoring rounds of twelve, plus twelve emails and their revisions, plus
   * the conversation around them, then multiplied to leave a legitimate call
   * comfortably clear. What it catches is a desk left in a loop, not a hiring
   * manager who is thorough. Pick yours from what `usage.updated` reports on a
   * real screening.
   *
   * Reaching it ends the session at the next turn; a `ctx.generate` or
   * `ctx.delegate` in between is refused with the same reason, which
   * `mapSettled` reports per candidate rather than losing the whole fan-out.
   */
  usageLimits: { totalTokens: 750_000 },
  // The ranking, the feedback trail and the drafts' subject lines, pushed after
  // every tool call — a leaderboard is the one thing here nobody can hold by ear.
  syncState: hiringProjection,
  greeting:
    "Hiring desk. I've got the applicants for the Junior React Developer contract in front " +
    "of me — want me to screen them, or are you hiring for something else?",
});
