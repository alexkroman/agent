// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a CALL — a sequence of turns — rather than one reply.
 *
 * `eval/events.ts` reads one event list; `EvalSession.say()` hands back one
 * {@link EvalTurn}. What sat between them and was hand-rolled in every template
 * that drives more than one utterance is the sequence: every tool call across a
 * whole call, and the turn a mechanism actually fired in.
 *
 * **That last one is the load-bearing idea, and it is why these are published
 * rather than left as four lines per file.** Three template evals independently
 * wrote the same paragraph above their own copy: a case must assert about the
 * turn a MECHANISM fired in, never about turn number two, because how many turns
 * an agent takes to get somewhere is the model's business and it measurably
 * varies — `retail`'s desk reads an order back before it stages, and its staging
 * call has landed in turn two, three and four across live runs. A case pinned to
 * a turn index is a flake with a misleading name, and it fails on a change to
 * the agent's manner rather than to its behaviour.
 *
 * So {@link turnCalling} is the spelling that makes the right claim cheap, and
 * `EvalSession.sayAll()` is what produces the list it reads. The three of them
 * are one affordance split across two modules only because a method belongs on
 * the session.
 *
 * These live here rather than in `eval/events.ts` for a mechanical reason worth
 * stating: {@link EvalTurn} is declared in `eval/session.ts`, which imports
 * `eval/events.ts` — so a function over turns placed there would close a cycle.
 * The dependency runs `turns.ts` -> `session.ts` -> `events.ts` and only that
 * way. The alternative was to type the parameter structurally, which was
 * rejected because a structural `{ text, toolCalls }` cannot see `completed`,
 * and a cancelled reply is exactly what explains a turn that said nothing.
 *
 * @module
 */

import { describeToolCalls, type EvalToolCall } from "./events.ts";
import type { EvalTurn } from "./session.ts";

/**
 * How much of a reply a failure message carries.
 *
 * A reply is a spoken paragraph and a case's message is read in a terminal
 * beside a stack, so the whole of a long one buries the tool list it sits next
 * to. Elided rather than truncated: the length is printed, so a reader can tell
 * a cut-off reply from one that really ended there.
 */
const SAID_MAX = 240;

/**
 * One turn as one line — what the agent did, for the message argument of a
 * failing assertion.
 *
 * **The highest-count duplication in the eval corpus**: ten sites across five
 * templates, four of them byte-identical
 * (`` `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}` ``),
 * and every one of them the `message` argument to `expect(value, message)`. That
 * is the harness's own job. The readers in `eval/events.ts` throw with names
 * precisely because a legible failure is what makes a noisy instrument usable,
 * and then each case built the sentence by hand anyway.
 *
 * What it is worth is the failure it turns into a finding.
 * `expect(started).toBeDefined()` prints "expected undefined to be defined",
 * which says nothing about a concierge that talked through three turns without
 * ever staging the change — the failure `travel-concierge`'s own comment records
 * this message catching.
 *
 * Three things it says that a hand-rolled copy did not:
 *
 * - **"called no tools"**, never `[]`. The empty list is the case the message
 *   exists for — the agent answered with a question instead of acting — and an
 *   empty bracket reads like the message got truncated.
 * - **"said nothing"**, never a trailing `said: `. A reply with no committed
 *   text is a real outcome and the bare form reads as a broken message.
 * - **"(the reply was cancelled)"**, which is usually the REASON for the other
 *   two: a cancelled reply is a finding rather than a harness failure
 *   ({@link EvalTurn.completed}), and it is the one fact that explains a turn
 *   that did nothing and said nothing.
 *
 * ```ts
 * import { describeTurn, type EvalTurn } from "@alexkroman1/aai-runtime/eval";
 *
 * export function stagedOn(turn: EvalTurn): void {
 *   const staged = turn.toolCalls.find((call) => call.name === "update_ticket");
 *   if (staged === undefined) throw new Error(describeTurn(turn));
 * }
 * ```
 */
export function describeTurn(turn: EvalTurn): string {
  const said = turn.text === "" ? "said nothing" : `said ${elide(turn.text)}`;
  return `${describeToolCalls(turn.toolCalls)}; ${said}${
    turn.completed ? "" : " (the reply was cancelled)"
  }`;
}

/** A reply quoted for a one-line message, with a long one's length named. */
function elide(text: string): string {
  return text.length <= SAID_MAX
    ? JSON.stringify(text)
    : `${JSON.stringify(`${text.slice(0, SAID_MAX)}…`)} (${text.length} chars)`;
}

/**
 * Every tool call across `turns`, flattened, in call order — the whole call.
 *
 * `EvalSession.toolCalls()` answers the same question about the SESSION, and the
 * difference is the greeting: the session's list carries every call from the
 * agent's opening line onward, where this carries only the turns a case actually
 * drove. A claim about "the call" that accidentally includes the greeting is the
 * same class of mistake as a claim about `said()` that does — see
 * {@link EvalTurn}.
 *
 * Hand-rolled in `travel-concierge` as `callsIn`, which is where the name comes
 * from. Pair it with `toolNames` for an order claim, or with `toolArgsIn` /
 * `toolResultsIn` for what each was asked and answered.
 */
export function callsIn(turns: readonly EvalTurn[]): readonly EvalToolCall[] {
  return turns.flatMap((turn) => turn.toolCalls);
}

/**
 * The turn `name` was called in — the FIRST one, and a throw naming what
 * happened instead when there is none.
 *
 * The claim a multi-turn case actually wants to make, and the whole reason
 * {@link EvalSession.sayAll} exists: "the desk staged the change on the turn it
 * staged it", never "on turn two". Written out in `retail` as `turnCalling`, in
 * `travel-concierge` as `stagingTurn` and in `dispatch-center` as an inline
 * `turns.find(…)`, each under a doc making the same argument.
 *
 * **It THROWS rather than answering `undefined`, which is a deliberate break
 * with the shape the templates had.** Every one of them wrote
 * `const staging = turnCalling(turns, tool)` followed by
 * `expect(staging, "<hand-built message>").toBeDefined()` and then read fields
 * off `staging?.…` — three lines and an optional chain to recover from a `find`
 * that missed. This is the rule the readers next door already follow: the
 * singular form throws because for it an absent match can only be a mistake, and
 * the plural answers `[]` because "it never called this" is a claim a case
 * makes. The plural spelling of THIS claim is
 * `expect(toolNames(callsIn(turns))).not.toContain(name)`, which needs no turn
 * at all — so nothing is lost, and the return type is `EvalTurn` rather than
 * `EvalTurn | undefined`, which is what retires the optional chain.
 *
 * The throw carries what a hand-built message could not afford to: every turn's
 * tool list, in order, so the failure reads as the shape of the call rather than
 * as one missing name.
 *
 * `where` narrows to a call that also satisfies a predicate — the near-variant
 * `travel-concierge` needed, where the interesting turn is the one whose
 * `update_ticket` STAGED something rather than being refused by the gate. When
 * the tool was called and no call matched, the message says so rather than
 * reporting the tool as never called: those are different findings and only one
 * of them is about the agent ignoring the tool.
 *
 * ```ts
 * import { type EvalSession, toolResultIn, turnCalling } from "@alexkroman1/aai-runtime/eval";
 * import { z } from "zod";
 *
 * export async function stagesBeforeCommitting(session: EvalSession): Promise<string> {
 *   const turns = await session.sayAll(["I want to cancel W1234", "Go ahead."]);
 *   // The turn it staged in, whichever that turned out to be.
 *   const staging = turnCalling(turns, "cancel_pending_order");
 *   return toolResultIn(staging.toolCalls, "cancel_pending_order", z.object({ state: z.string() }))
 *     .state;
 * }
 * ```
 */
export function turnCalling(
  turns: readonly EvalTurn[],
  name: string,
  where?: (call: EvalToolCall) => boolean,
): EvalTurn {
  const found = turns.find((turn) =>
    turn.toolCalls.some((call) => call.name === name && (where === undefined || where(call))),
  );
  if (found !== undefined) return found;
  const attempts = callsIn(turns).filter((call) => call.name === name);
  const missed =
    attempts.length > 0
      ? `${attempts.length} call(s) to ${JSON.stringify(name)} and none matched the predicate`
      : `no turn called ${JSON.stringify(name)}`;
  const shape =
    turns.length === 0
      ? "no turns were driven"
      : turns.map((turn, at) => `turn ${at + 1} ${describeToolCalls(turn.toolCalls)}`).join("; ");
  throw new Error(`${missed}: ${shape}`);
}
