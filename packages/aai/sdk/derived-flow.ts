// Copyright 2026 the AAI authors. MIT license.
/**
 * `derivedFlow()` — a dialog statechart whose position is COMPUTED from the data
 * rather than stored beside it.
 *
 * {@link flow} stores an XState snapshot in its own slot and moves it with
 * events. That makes the position a SECOND SOURCE OF TRUTH: the first is the
 * slot the agent actually keeps its state in, and the two are held in step by
 * convention — every tool moves both. When a convention is what holds an
 * invariant, the invariant eventually does not hold.
 *
 * ## What the divergence actually costs
 *
 * It is not a crash, and that is the whole problem: **the refusal a stale
 * position produces READS CORRECT.** It names a real state and quotes that
 * state's real instruction, so nothing at any level looks wrong. The model
 * apologizes and retries something that cannot work.
 *
 * The worked case is `solo-rpg`. `save_game` is legal while a roll is standing;
 * `load_game` rebuilt the position from the save without looking at the roll. So
 * a reloaded save sat in `playing.awaitingRoll` with `lastRoll` still set, and
 * `burn_momentum` — gated on `playing.rollResolved` — refused a burn the
 * campaign data plainly allowed, telling the model to go and roll instead. Every
 * test passed, because every test asserted the position the tools agreed on.
 *
 * ## Deriving makes it unrepresentable
 *
 * Here the position is `locate(data)`, a pure function of the slot's value. It
 * cannot be stale, because there is nothing to keep in step: the body writes the
 * data, and the position that body's result carries is READ BACK from the data
 * it just wrote. There is no event to forget to send, no restore path to keep
 * exhaustive, and no snapshot to migrate when a machine gains a state.
 *
 * Four things follow from that, and they are the reason to prefer this shape
 * wherever it fits:
 *
 *   * **No `send`, no `sendFrom`, no `reset`.** A tool declares only WHERE it
 *     may run. What moves the conversation on is the write it already makes.
 *   * **The gate and the guard become one fact.** `when: "serving"` and
 *     `if (!state.authenticatedUserId)` were the same question asked twice, and
 *     the guards that "were replaced" by `flow()` mostly survived as defence
 *     against exactly the divergence this removes.
 *   * **No actor is ever started.** `flow()` starts and stops one per read —
 *     three to four per gated call — because a session outlives its process and
 *     a live actor cannot be cached across that. A pure function of the data has
 *     nothing to start.
 *   * **`locate` is unit-testable on its own**, with no context, no slot and no
 *     session. It is the whole state machine's transition relation as one
 *     total function, which is the thing worth having a spec for.
 *
 * ## When to keep {@link flow} instead
 *
 * When the position genuinely carries HISTORY the data does not. `dispatch-center`
 * is the case in this repo: whether a call is at `triaging` or `dispatching` is
 * not a function of the board — the same set of incidents and units is reachable
 * either way — because what those states record is what the DISPATCHER has
 * already done, not what is true of the world. A derived flow forces that to be
 * either real data or nothing, which is usually the honest outcome and sometimes
 * a genuine loss. Reach for {@link FlowOptions.invariant} there instead.
 *
 * @module derived-flow
 */

import type { AnyStateMachine } from "xstate";
import { finalPaths, instructionAt, statePaths } from "./_flow-snapshot.ts";
import { buildFlowTool } from "./_flow-tool.ts";
import type { DeepReadonly } from "./deep-readonly.ts";
import type { FlowPosition } from "./flow.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { SessionSlot } from "./session-slot.ts";
import type { StateProjection } from "./session-state.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

/**
 * The authoring shape of a tool on a derived flow — {@link FlowToolDef} minus
 * the two transition fields, because there is no transition to declare.
 *
 * Declared here in full rather than aliased to the gate's internal shape: an
 * alias to a type this package does not export leaves the public surface
 * pointing at something a reader cannot import or read the docs for, which is
 * the "forgotten export" the API report exists to surface. It also means the
 * members carry their own documentation, which an alias cannot.
 *
 * @typeParam P - The tool's input schema.
 * @typeParam R - What `execute` returns.
 *
 * @public
 */
export interface DerivedFlowToolDef<P extends ToolInputSchema, R> {
  /** See {@link ToolDef.description} — what the model reads to decide to call it. */
  description: string;
  /** See {@link ToolDef.inputSchema}. */
  inputSchema?: P;
  /**
   * The state(s) this tool may run in, as {@link FlowPosition.state} spells
   * them. Anywhere else the body does not run and the call is refused.
   *
   * Checked against the machine's own states when the tool is DECLARED, so a
   * typo throws at startup rather than leaving a tool silently unreachable.
   */
  when: string | readonly string[];
  /**
   * The tool body. Runs only in one of `when`'s states.
   *
   * **There is no `send` beside it, and that absence is the primitive.** The
   * write this body makes to the flow's slot IS the transition, so the position
   * the result carries is read back from the data the body just wrote — which is
   * why a `ToolFailure` cannot leave the flow a step ahead of reality. There is
   * no separate event that could have fired.
   *
   * May be async: the result is AWAITED before the position is read back.
   */
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): R | ToolFailure | Promise<R | ToolFailure>;
}

/**
 * A dialog statechart computed from a slot, created by {@link derivedFlow}.
 *
 * @typeParam M - The XState machine whose states name the positions.
 * @typeParam T - The slot's value type, which `locate` reads.
 *
 * @public
 */
export interface DerivedFlow<M extends AnyStateMachine, T> {
  /** The machine, for a caller that wants to inspect or visualize it. */
  readonly machine: M;
  /** Where the conversation is, computed from the slot as it stands now. */
  position(ctx: ToolContext): FlowPosition;
  /** Whether the computed position matches `state`, as `when` spells it. */
  matches(ctx: ToolContext, state: string): boolean;
  /**
   * The derivation itself, exposed so a spec can drive it directly.
   *
   * This is the point of the whole primitive: the transition relation is one
   * total function of the data, so it can be tested exhaustively without a
   * session, a context or a tool call.
   */
  locate(data: DeepReadonly<T>): string;
  /** Declare a tool gated on this flow's computed position. */
  tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
    def: DerivedFlowToolDef<P, R>,
  ): ToolDef<P>;
  /**
   * A `syncState` projection of the computed position.
   *
   * Free here, where {@link Flow.projection} needs an actor: it is the SLOT's
   * own projection with `locate` applied, so a client renders the step the
   * caller is on from the same data every gate reads.
   */
  projection<V>(project: (position: FlowPosition) => V): StateProjection<V>;
}

/**
 * The error a derivation that names a state the machine does not have throws.
 *
 * It THROWS rather than refusing, which is the one place this primitive is
 * deliberately harsher than {@link flow}. A divergence is data-dependent and can
 * first appear in production, so it is reported; an unknown state path is a pure
 * programming error in `locate` that fires on the FIRST call in any test, so it
 * cannot reach production and a throw names it at the line that caused it.
 *
 * @public
 */
export class UnknownFlowStateError extends Error {
  /** What `locate` returned. */
  readonly state: string;

  constructor(machineId: string, state: string, valid: ReadonlySet<string>) {
    super(
      `The "${machineId}" flow's locate() returned "${state}", which is not one of its states: ${[...valid].sort().join(", ")}.`,
    );
    this.name = "UnknownFlowStateError";
    this.state = state;
  }
}

/**
 * Declare a dialog statechart whose position is a function of a slot's value.
 *
 * @param machine - The machine whose states name the positions, and whose
 *   `meta.instruction` supplies {@link FlowPosition.instruction}. Its
 *   transitions are documentation here rather than enforcement — `locate` is
 *   what decides where the conversation is — so a machine written for a derived
 *   flow may declare `on` blocks for a reader and a visualizer, or none at all.
 * @param slot - The slot the position is read from. This is the agent's own
 *   state; the flow adds no storage of its own.
 * @param locate - The derivation: the data in, a state path out. Total, pure,
 *   and the thing to write a spec for.
 *
 * @example
 * ```ts
 * import { derivedFlow, sessionSlot } from "@alexkroman1/aai";
 * import { setup } from "xstate";
 *
 * interface Call {
 *   customerId: string | null;
 *   transferred: boolean;
 * }
 *
 * const callSlot = sessionSlot("call", (): Call => ({ customerId: null, transferred: false }));
 *
 * const machine = setup({}).createMachine({
 *   id: "call",
 *   initial: "identifying",
 *   states: {
 *     identifying: { meta: { instruction: "Find out who this is before anything else." } },
 *     serving: { meta: { instruction: "Help this one customer, and say what you will change." } },
 *     transferred: { type: "final", meta: { instruction: "A human has the call now. Say nothing else." } },
 *   },
 * });
 *
 * // The position IS the data — there is no second thing to keep in step.
 * export const call = derivedFlow(machine, callSlot, (data) =>
 *   data.transferred ? "transferred" : data.customerId === null ? "identifying" : "serving",
 * );
 * ```
 *
 * @public
 */
export function derivedFlow<M extends AnyStateMachine, K extends string, T>(
  machine: M,
  slot: SessionSlot<K, T>,
  locate: (data: DeepReadonly<T>) => string,
): DerivedFlow<M, T> {
  const valid = statePaths(machine);
  const finals = finalPaths(machine);
  const id = String(machine.id);

  const positionFor = (data: DeepReadonly<T>): FlowPosition => {
    const state = locate(data);
    if (!valid.has(state)) throw new UnknownFlowStateError(id, state, valid);
    return {
      state,
      // The ROOT segment decides. `finalPaths` collects finals at every depth,
      // because a nested one is legal and means something else — it completes
      // its REGION. So `playing.sceneClosed` is a final state and the machine is
      // not done, because `playing` is not one.
      done: finals.has(state.split(".")[0] ?? state),
      // `exactOptionalPropertyTypes` is on, so an absent instruction has to be
      // ABSENT rather than set to `undefined` (guard-invariants rule 2).
      ...omitUndefined({ instruction: instructionAt(machine, state) }),
    };
  };

  const position = (ctx: ToolContext): FlowPosition => positionFor(slot.get(ctx));

  /**
   * Path matching, which is what `matches` means without an actor.
   *
   * A `when` may name either depth — `matches("playing")` is true while the data
   * puts the call in `playing.rollResolved` — so a prefix counts, and it must be
   * a prefix at a SEGMENT boundary: `"play"` must not match `"playing"`.
   */
  const matches = (ctx: ToolContext, state: string): boolean => {
    const at = position(ctx).state;
    return at === state || at.startsWith(`${state}.`);
  };

  return {
    machine,
    position,
    matches,
    locate,
    projection: <V>(project: (position: FlowPosition) => V): StateProjection<V> =>
      slot.projection((data) => project(positionFor(data))),
    tool: <P extends ToolInputSchema = ToolInputSchema, R = unknown>(
      def: DerivedFlowToolDef<P, R>,
    ): ToolDef<P> =>
      // No `advance`: the gate re-reads the position, and the body's own write to
      // the slot is what moved it. That absence IS the primitive.
      buildFlowTool<P, R>({ key: id, valid, position, matches }, def),
  };
}
