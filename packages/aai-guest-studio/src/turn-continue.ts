// Copyright 2026 the AAI authors. MIT license.
/**
 * Keep a turn alive while the agent's own plan says it is unfinished.
 *
 * **A step with no tool call ENDS the turn**, and nothing downstream can
 * reopen it. That is the AI SDK's loop condition, not a setting: it continues
 * "until a finish reason other than tool-calls is returned", and `stopWhen`
 * only ever ADDS stop conditions — there is no condition that means "keep
 * going". So a single sentence of prose is indistinguishable, mechanically,
 * from the agent declaring itself done.
 *
 * That is fine for an answer and wrong for everything else the model uses
 * prose for. Reproduced with the scripted-model harness: a turn with
 * `maxSteps: 8`, the wall-clock budget barely touched and **three todos still
 * pending** ended on one narration of an obstacle ("the page is
 * client-rendered, so I'll use the public menu") — the second `todo_write`
 * never ran. From the user's side the spinner simply stops, the plan is
 * visibly half-marked, and the only repair is to type "continue".
 *
 * The prompt cannot carry this alone, and its wording made it worse: the
 * preamble told the model that ASKING ends the turn — true of all prose, not
 * just questions — and then, two lines later, to "make the most reasonable
 * assumption, say what you assumed, and continue". Said as its own step, that
 * instruction ends the turn and the continuation it promises never happens.
 * The wording is fixed; this module is the half that does not depend on the
 * model reading it.
 *
 * **The lever is `toolChoice: "required"`, applied per step.** Since the turn
 * is already over by the time a text-only step exists, there is nothing to
 * react to after the fact — the stall has to be made unrepresentable BEFORE
 * the step runs. Requiring a tool call does exactly that, and it costs the
 * model no expressiveness: text and a tool call in ONE step are still allowed,
 * so it can narrate all it likes as long as it also keeps working. What it
 * cannot do is narrate INSTEAD of working.
 *
 * Three independent releases, because a forced tool call must never become a
 * trap:
 *
 * - **An empty plan never forces.** The count comes from the model's own last
 *   `todo_write`, so a single-step change or a question — which the preamble
 *   tells it to run without a todo list at all — is untouched. The mechanism
 *   only engages once the model has itself declared multi-step work.
 * - **`todo_write` is always a legal move**, so the escape is one step away
 *   and always available: marking the rest `completed` or `cancelled` drops
 *   the count to zero and the next step is free. The notice says so, because
 *   a constraint a model cannot see the exit from is one it fights.
 * - **{@link MAX_FORCED_STEPS}, and the caller's wrap-up gate.** `chat.ts`
 *   stops consulting this module once the soft deadline has fired, because
 *   the wrap-up notice asks for a spoken report and forcing a tool call would
 *   contradict it.
 *
 * Past those, the runtime still guarantees a final answer regardless: the
 * reserved step at `maxSteps` sets `toolChoice: "none"` and composes LAST, so
 * it wins this key outright (`forceFinalAnswer`, `aai-runtime/_prepare-step.ts`),
 * and the hard budget's closing step does the same. A forced turn therefore
 * cannot end mute.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { ModelMessage } from "ai";

import type { TurnBudget } from "./turn-budget.ts";

/**
 * How many steps one turn may be held open this way.
 *
 * Generous against `MAX_CHAT_STEPS` (80) rather than tight, because forcing is
 * a NO-OP on a step the model was going to spend on a tool anyway — which is
 * nearly all of them while a plan is open. Spending the allowance early would
 * therefore leave it exhausted exactly where stalls are most common, which is
 * deep into a long build, not at the start.
 */
export const MAX_FORCED_STEPS = 25;

/** The statuses `todo_write` itself counts as outstanding — see `renderTodos`. */
const OUTSTANDING = new Set(["pending", "in_progress"]);

/**
 * Outstanding items in the model's most recent `todo_write`, or 0 if it has
 * sent none.
 *
 * Read off the tool CALL's input rather than the rendered result: the input is
 * the model's own structured list, while the result is prose built for the
 * model to read (`"[x] …\n\n3 remaining"`) and parsing it back would couple
 * this decision to that formatting. Counted with `renderTodos`'s own rule —
 * `cancelled` is not outstanding, which is what makes it an escape hatch and
 * not just a third way to stay stuck.
 */
export function pendingTodoCount(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part: unknown = content[j];
      if (!isRecord(part) || part.type !== "tool-call" || part.toolName !== "todo_write") continue;
      const input = part.input;
      if (!(isRecord(input) && Array.isArray(input.todos))) return 0;
      return input.todos.filter((t: unknown) => isRecord(t) && OUTSTANDING.has(String(t.status)))
        .length;
    }
  }
  return 0;
}

/** What the model is told the first time a step is held open. */
export function keepGoingNotice(pending: number): string {
  const items = pending === 1 ? "1 item" : `${pending} items`;
  return (
    `Your plan still has ${items} outstanding, so this step must call a tool. ` +
    "A reply with no tool call ENDS your turn — the user would have to ask you to " +
    "continue, and from their side the work just stops half-done. Keep going: if you " +
    "need to explain something, report an obstacle, or state an assumption, put it in " +
    "the SAME step as your next tool call rather than on its own. If the remaining " +
    "items are already done or no longer apply, send todo_write marking them completed " +
    "or cancelled — then you are free to reply."
  );
}

export type KeepGoing = {
  /**
   * Decide one step. `force` obliges a tool call; `notice` is the explanation,
   * returned at most once per turn.
   */
  consider: (messages: readonly ModelMessage[]) => { force: boolean; notice: string | null };
};

export function createKeepGoing(maxForced = MAX_FORCED_STEPS): KeepGoing {
  let forced = 0;
  let noticed = false;
  return {
    consider: (messages) => {
      if (forced >= maxForced) return { force: false, notice: null };
      const pending = pendingTodoCount(messages);
      if (pending === 0) return { force: false, notice: null };
      forced++;
      // Once only: repeating it every step would crowd the context it is
      // protecting, the same reason the budget's notices fire once.
      if (noticed) return { force: true, notice: null };
      noticed = true;
      return { force: true, notice: keepGoingNotice(pending) };
    },
  };
}

/**
 * The whole per-step decision for one chat turn, as a pure function.
 *
 * Three rules share one key (`toolChoice`) and their ORDER is the behaviour,
 * so they are decided here rather than inline in `chat.ts`'s `prepareStep`:
 * the hard deadline's closing step takes tools away, the soft deadline's
 * wrap-up asks for a spoken report and therefore must not be overridden by a
 * forced tool call, and only inside both does the keep-going force apply.
 * Written as a branch chain in an HTTP handler that also does compaction, the
 * ordering was the one part with no test and the most ways to be wrong.
 *
 * `base` is the possibly-compacted list and `stepMessages` the original:
 * returning `{}` rather than `{ messages }` when nothing changed is what keeps
 * an untouched step from re-sending a list the SDK already has.
 */
export function prepareTurnStep(options: {
  readonly base: readonly ModelMessage[];
  readonly stepMessages: readonly ModelMessage[];
  readonly budget: Pick<TurnBudget, "takeFinalNotice" | "takeWrapUpNotice" | "wrappingUp">;
  readonly keepGoing: KeepGoing;
}): { messages?: ModelMessage[]; toolChoice?: "none" | "required" } {
  const { base, stepMessages, budget, keepGoing } = options;
  const say = (content: string): ModelMessage => ({ role: "user", content });

  // Past the hard deadline the turn gets exactly one more step, with tools
  // off, so it ends on something the user can read rather than on whatever
  // tool call happened to be in flight.
  const final = budget.takeFinalNotice();
  if (final) return { messages: [...base, say(final)], toolChoice: "none" };

  const wrapUp = budget.takeWrapUpNotice();
  if (wrapUp) return { messages: [...base, say(wrapUp)] };

  // Still inside the soft deadline: hold the turn open while the model's own
  // todo list says there is work left.
  if (!budget.wrappingUp()) {
    const { force, notice } = keepGoing.consider(base);
    if (force) {
      return { messages: notice ? [...base, say(notice)] : [...base], toolChoice: "required" };
    }
  }
  return base === stepMessages ? {} : { messages: [...base] };
}
