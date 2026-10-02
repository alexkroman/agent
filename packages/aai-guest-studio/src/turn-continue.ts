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
 * - **{@link MAX_FORCED_STEPS}, and the wrap-up gate.** {@link stepTurn}
 *   stops forcing once the soft deadline has passed, because the wrap-up
 *   notice asks for a spoken report and forcing a tool call would contradict
 *   it.
 *
 * Past those, the runtime still guarantees a final answer regardless: the
 * reserved step at `maxSteps` sets `toolChoice: "none"` and composes LAST, so
 * it wins this key outright (`forceFinalAnswer`, `aai-runtime/_prepare-step.ts`),
 * and the hard budget's closing step does the same. A forced turn therefore
 * cannot end mute.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { ModelMessage } from "ai";

import { closingNotice, HARD_TURN_MS, SOFT_TURN_MS, wrapUpNotice } from "./turn-budget.ts";

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

// ---- The turn's step policy -------------------------------------------------

/**
 * Where one chat turn is, as ONE field.
 *
 * - `working` — inside the soft deadline; the keep-going force may apply.
 * - `wrapUpSent` — the soft deadline's wrap-up notice has been delivered. The
 *   force stands down from the soft deadline on, because the notice asks for a
 *   spoken report and obliging a tool call would contradict it.
 * - `finalSent` — the hard deadline's tool-free closing step has been handed
 *   out. Terminal: the loop stops after that step ({@link turnExpired}).
 *
 * The time thresholds are observations, not phases: a turn in `working` past
 * the soft deadline is one whose wrap-up notice is about to be sent.
 */
export type TurnPhase = "working" | "wrapUpSent" | "finalSent";

/**
 * The phase plus how many steps have been held open. `forced` is a count
 * because {@link MAX_FORCED_STEPS} caps it; the keep-going notice fires on the
 * first forced step, so "already explained" is `forced > 0`, not a flag.
 */
export type TurnState = { readonly phase: TurnPhase; readonly forced: number };

export const INITIAL_TURN_STATE: TurnState = { phase: "working", forced: 0 };

/** What one step sees: the turn's clock and the model's own plan. */
export type TurnObservation = {
  readonly elapsedMs: number;
  /** Outstanding items in the latest `todo_write` ({@link pendingTodoCount}). */
  readonly pending: number;
};

export type TurnLimits = {
  readonly softMs: number;
  readonly hardMs: number;
  readonly maxForced: number;
};

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  softMs: SOFT_TURN_MS,
  hardMs: HARD_TURN_MS,
  maxForced: MAX_FORCED_STEPS,
};

/**
 * What a step does about the turn policy.
 *
 * - `close` — append the closing notice, `toolChoice: "none"`.
 * - `wrapUp` — append the wrap-up notice; no `toolChoice`.
 * - `force` — `toolChoice: "required"`, with the keep-going notice appended when
 *   `explain` (the first forced step of the turn only: repeating it would crowd
 *   the context it is protecting, the same reason the deadline notices fire once).
 * - `pass` — nothing.
 */
export type TurnAction =
  | { readonly kind: "close" }
  | { readonly kind: "wrapUp" }
  | { readonly kind: "force"; readonly explain: boolean }
  | { readonly kind: "pass" };

/**
 * The per-step decision as a pure reducer: `(state, observation) → { state, action }`.
 *
 * Three rules share one key (`toolChoice`), and the order of the branches below
 * IS the behaviour: the hard deadline's closing step takes tools away and wins
 * outright; the soft deadline's wrap-up must not be overridden by a forced tool
 * call; and only inside the soft deadline does the keep-going force apply.
 */
export function stepTurn(
  state: TurnState,
  { elapsedMs, pending }: TurnObservation,
  limits: TurnLimits = DEFAULT_TURN_LIMITS,
): { state: TurnState; action: TurnAction } {
  const pass = { state, action: { kind: "pass" } } as const;
  if (state.phase === "finalSent") return pass;
  // Past the hard deadline the turn gets exactly one more step, with tools
  // off, so it ends on something the user can read rather than on whatever
  // tool call happened to be in flight.
  if (elapsedMs >= limits.hardMs) {
    return { state: { ...state, phase: "finalSent" }, action: { kind: "close" } };
  }
  if (state.phase === "working" && elapsedMs >= limits.softMs) {
    return { state: { ...state, phase: "wrapUpSent" }, action: { kind: "wrapUp" } };
  }
  // From the soft deadline on the force stands down — read off the clock, not
  // the phase, so it holds on every step past the deadline.
  if (elapsedMs >= limits.softMs) return pass;
  // Still inside the soft deadline: hold the turn open while the model's own
  // todo list says there is work left, up to the cap.
  if (pending === 0 || state.forced >= limits.maxForced) return pass;
  return {
    state: { ...state, forced: state.forced + 1 },
    action: { kind: "force", explain: state.forced === 0 },
  };
}

/** True once the loop must stop: after the closing step was handed out. */
export function turnExpired(state: TurnState): boolean {
  return state.phase === "finalSent";
}

/**
 * An action, applied to one step's messages.
 *
 * `base` is the possibly-compacted list and `stepMessages` the original:
 * returning `{}` rather than `{ messages }` when nothing changed is what keeps
 * an untouched step from re-sending a list the SDK already has.
 */
export function prepareTurnStep(options: {
  readonly base: readonly ModelMessage[];
  readonly stepMessages: readonly ModelMessage[];
  readonly action: TurnAction;
  readonly observation: TurnObservation;
}): { messages?: ModelMessage[]; toolChoice?: "none" | "required" } {
  const { base, stepMessages, action, observation } = options;
  const say = (content: string): ModelMessage => ({ role: "user", content });
  if (action.kind === "close") {
    return { messages: [...base, say(closingNotice(observation.elapsedMs))], toolChoice: "none" };
  }
  if (action.kind === "wrapUp") {
    return { messages: [...base, say(wrapUpNotice(observation.elapsedMs))] };
  }
  if (action.kind === "force") {
    return {
      messages: action.explain ? [...base, say(keepGoingNotice(observation.pending))] : [...base],
      toolChoice: "required",
    };
  }
  return base === stepMessages ? {} : { messages: [...base] };
}

/** One turn's policy: the reducer's state, the clock, and the step hook. */
export type TurnPolicy = {
  /** The turn policy's `prepareStep` contribution for this step. */
  prepare: (
    base: readonly ModelMessage[],
    stepMessages: readonly ModelMessage[],
  ) => ReturnType<typeof prepareTurnStep>;
  /** The extra `stopWhen` — see {@link turnExpired}. */
  expired: () => boolean;
};

/** The thin stateful shell over {@link stepTurn}: one turn, one clock. */
export function createTurnPolicy(
  now: () => number = Date.now,
  limits: TurnLimits = DEFAULT_TURN_LIMITS,
): TurnPolicy {
  const started = now();
  let state = INITIAL_TURN_STATE;
  return {
    prepare: (base, stepMessages) => {
      const observation = { elapsedMs: now() - started, pending: pendingTodoCount(base) };
      const next = stepTurn(state, observation, limits);
      state = next.state;
      return prepareTurnStep({ base, stepMessages, action: next.action, observation });
    },
    expired: () => turnExpired(state),
  };
}
