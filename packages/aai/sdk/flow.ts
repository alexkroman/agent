// Copyright 2026 the AAI authors. MIT license.
/**
 * `flow()` — a dialog statechart, so what an agent may do NEXT is declared
 * rather than asked for in prose.
 *
 * The SDK had two authoring time-scales and nothing in between. `workflow()`
 * owns DURABLE time — minutes to days, surviving process death, journaled per
 * step. {@link sessionSlot} owns the DATA a session accumulates. Neither says
 * anything about ORDER, and order is most of what a guided voice call is: ask
 * for the policy number before quoting, read the disclosure before taking the
 * card, verify identity before disclosing a balance.
 *
 * Until now the only way to express that was prose in `systemPrompt` plus trust.
 * Every tool in a `tools/` directory is available on every turn, so "ask these
 * questions in this order" was advice to a model rather than a property of the
 * agent — and `support-line/graph.ts` is what that costs at the far end: 224
 * lines of hand-rolled control flow, with the node names it came from preserved
 * in a trace so a run stays readable as the graph it used to be.
 *
 * ## The enforcement point is EXECUTION, not advertisement
 *
 * The obvious design is to vary the tool list per turn. It is not available, and
 * would not be enough if it were:
 *
 *   * `AgentDef.systemPrompt` is a `string` resolved once, and `toolSchemas` is
 *     computed once in `host/runtime-tools.ts` and handed to the transport at
 *     session creation. Both are per-SESSION by construction.
 *   * The AssemblyAI S2S service runs its tool loop SERVICE-SIDE. There is no
 *     per-turn moment on that path to re-advertise anything, so a gate built on
 *     the schema list would silently not exist in one of the three transports.
 *
 * So a {@link Flow.tool} refuses at EXECUTION: out of state it runs nothing and
 * returns a {@link ToolFailure} naming where the conversation actually is and
 * what has to happen first. Every transport routes execution through the same
 * `executeTool`, so the gate holds identically on all three — and a refusal the
 * model can read is the recovery path the model needs anyway. A schema gate
 * would have hidden the tool and left it guessing.
 *
 * That is a real guarantee rather than a stronger prompt: the body does not run.
 * What it is NOT is a claim that the model will stop ASKING; it will sometimes
 * call a gated tool early, get refused, and be told what to do. That is the
 * intended loop, and it is why the refusal carries the instruction.
 *
 * ## The state IS the readout
 *
 * A {@link Flow.tool} answers {@link FlowToolResult} — the author's own return
 * value under `result`, wrapped in the position the flow is in AFTER the call.
 * The shape is unconditional on purpose: a tool result is the last thing the
 * model reads before it speaks, so the current state and its instruction arrive
 * every time rather than only when an author remembered to include them. That
 * is the state-addressed prompt this design gets without a per-turn prompt,
 * which the transports cannot give it.
 *
 * @module flow
 */

import { type AnyStateMachine, createActor, type EventFromLogic } from "xstate";
import {
  type FlowState,
  readState,
  statePaths,
  toInstruction,
  toStatePath,
} from "./_flow-snapshot.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import { type SessionSlot, sessionSlot } from "./session-slot.ts";
import type { StateProjection } from "./session-state.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure, type ToolFailure, toolFailure } from "./utils.ts";

/**
 * Where a flow currently is.
 *
 * @public
 */
export interface FlowPosition {
  /**
   * The active state as a dotted path — `"verifying"`, or `"quote.pending"` for
   * a nested one. Parallel regions are joined with `","`.
   */
  readonly state: string;
  /** Whether the machine has reached a final state. */
  readonly done: boolean;
  /**
   * The active state's `meta.instruction`, when it declares one — what the
   * agent is supposed to be doing here, in the words the state itself carries.
   *
   * Read from the DEEPEST active state node, so a nested state's instruction
   * wins over its parent's rather than being merged with it.
   */
  readonly instruction?: string;
}

/**
 * What a {@link Flow.tool} answers on success.
 *
 * @typeParam R - The author's own `execute` return type, under `result`.
 *
 * @public
 */
export interface FlowToolResult<R> extends FlowPosition {
  /** Whatever the tool's own `execute` returned. */
  readonly result: R;
}

/**
 * The authoring shape of a gated tool — {@link ToolDef} plus the two things
 * that make it part of a flow: where it may run, and what it advances.
 *
 * @typeParam P - The tool's input schema.
 * @typeParam R - What `execute` returns.
 * @typeParam E - The machine's event union.
 *
 * @public
 */
export interface FlowToolDef<P extends ToolInputSchema, R, E> {
  /** See {@link ToolDef.description} — what the model reads to decide to call it. */
  description: string;
  /** See {@link ToolDef.inputSchema}. */
  inputSchema?: P;
  /**
   * The state(s) this tool may run in, as {@link FlowPosition.state} spells
   * them. Anywhere else the body does not run and the call is refused.
   *
   * Every name is checked against the machine's own states when the tool is
   * DECLARED, so a typo is a throw at startup rather than a tool that is
   * silently unreachable for the life of the agent.
   */
  when: string | readonly string[];
  /**
   * The event to send once `execute` has succeeded — how the conversation moves
   * on. Omit both this and `sendFrom` for a tool that reads without advancing.
   *
   * **Nothing is sent when `execute` returns a {@link ToolFailure}.** A tool
   * that failed did not do the thing, so a flow that advanced anyway would
   * leave the conversation a step ahead of reality — the single most expensive
   * bug this primitive can have, since every later gate is then wrong too.
   */
  send?: E;
  /**
   * The event to send, decided by the RESULT — for a tool whose outcome picks
   * the transition. Return `undefined` to stay put.
   *
   * Separate from `send` rather than a union with it because a union of an
   * event and a function of one cannot be narrowed by `typeof`: an event type is
   * generic here, so TypeScript cannot rule out that it is itself callable, and
   * the check would need a cast to compile. Two fields are also the clearer
   * authoring surface — the static case stays a literal. Declaring both is an
   * error.
   */
  sendFrom?: (result: R) => E | undefined;
  /** The tool body. Runs only in one of `when`'s states. */
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): R;
}

/**
 * A dialog statechart bound to a session, created by {@link flow}.
 *
 * @typeParam M - The XState machine this flow runs.
 *
 * @public
 */
export interface Flow<M extends AnyStateMachine> {
  /** The store key this flow's snapshot occupies. Two flows must not share one. */
  readonly key: string;
  /** The machine itself, for a caller that wants to inspect or visualize it. */
  readonly machine: M;
  /** Where this session's conversation currently is. */
  position(ctx: ToolContext): FlowPosition;
  /** Whether the active state matches `state`, as `when` spells it. */
  matches(ctx: ToolContext, state: string): boolean;
  /**
   * Advance the flow, and store the result.
   *
   * An event the active state does not handle is IGNORED — XState's own
   * behaviour, kept rather than turned into a throw, because the alternative is
   * an agent that crashes a live call over a transition that merely was not
   * available. The returned position is what actually happened; compare its
   * `state` to know whether anything moved.
   */
  send(ctx: ToolContext, event: EventFromLogic<M>): FlowPosition;
  /** Discard this session's progress and start the flow over. */
  reset(ctx: ToolContext): FlowPosition;
  /** Declare a tool gated on this flow's state. See {@link FlowToolDef}. */
  tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
    def: FlowToolDef<P, R, EventFromLogic<M>>,
  ): ToolDef<P>;
  /**
   * A `syncState` projection of this flow's position, so a client can render
   * the step the caller is on without the agent hand-rolling a sync channel.
   *
   * The projector is REQUIRED, exactly as {@link SessionSlot.projection}'s is,
   * and for the same reason: an optional one cannot be typed without asserting
   * that the un-projected {@link FlowPosition} is the caller's `V`. Project the
   * identity — `flow.projection((at) => at)` — to push the whole position.
   */
  projection<V>(project: (position: FlowPosition) => V): StateProjection<V>;
}

/** Options for {@link flow}. */
export interface FlowOptions {
  /**
   * Whether this flow's position is stored durably. Defaults to `true` — see
   * {@link SessionSlotOptions.durable}. A persisted snapshot is plain JSON by
   * construction, so there is nothing here that cannot be stored.
   */
  durable?: boolean;
}

/**
 * Declare a dialog statechart for an agent's conversation.
 *
 * The machine is an ordinary XState machine, so everything XState knows how to
 * do with one applies — `@xstate/graph` can enumerate its paths to generate
 * dialog test cases, and the machine is serializable for a visualizer.
 *
 * @param key - The store key to occupy, like a {@link sessionSlot}'s. Two flows
 *   must not share one, and a flow must not share one with a slot.
 * @param machine - The machine. Give a state a `meta.instruction` and it becomes
 *   {@link FlowPosition.instruction} while that state is active — which is what
 *   a refusal quotes and what every flow tool's result carries.
 *
 * @example
 * ```ts
 * // shared.ts — the one place the flow is declared.
 * import { flow } from "@alexkroman1/aai";
 * import { setup } from "xstate";
 *
 * const machine = setup({
 *   types: {} as { events: { type: "VERIFIED" } | { type: "QUOTED" } },
 * }).createMachine({
 *   id: "claim",
 *   initial: "verifying",
 *   states: {
 *     verifying: {
 *       meta: { instruction: "Get the caller's policy number and verify it." },
 *       on: { VERIFIED: "quoting" },
 *     },
 *     quoting: {
 *       meta: { instruction: "Read the excess disclosure, then quote." },
 *       on: { QUOTED: "done" },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 *
 * export const claim = flow("claim", machine);
 * ```
 *
 * @example
 * ```ts no-check
 * // tools/quote_claim.ts — cannot run before the caller is verified.
 * // (`no-check`: the point of the example is the OTHER file's declaration.)
 * import { claim } from "../shared.ts";
 * import { z } from "zod";
 *
 * export default claim.tool({
 *   description: "Quote the claim once the policy is verified",
 *   inputSchema: z.object({ excess: z.number() }),
 *   when: "quoting",
 *   send: { type: "QUOTED" },
 *   execute: ({ excess }) => ({ premium: excess * 2 }),
 * });
 * ```
 *
 * @public
 */
export function flow<M extends AnyStateMachine>(
  key: string,
  machine: M,
  options: FlowOptions = {},
): Flow<M> {
  const valid = statePaths(machine);

  /**
   * A started actor for this session's stored snapshot.
   *
   * Started fresh per call rather than cached per session, and that is the
   * design: an actor is a LIVE object with subscriptions behind it, so caching
   * one would make the flow's lifetime the process's rather than the session's —
   * and a session outlives the process it started in (it survives a disconnect
   * through the resume grace window, and on the platform it can resume in a
   * different sandbox entirely). The snapshot is the state; the actor is a
   * short-lived reader of it, and every caller here stops the one it made.
   */
  const actorFor = (state: FlowState | undefined) => {
    const restored = state?.snapshot;
    // WIDENED to `AnyStateMachine` deliberately, and it is an assignment rather
    // than an assertion. `SnapshotFrom<M>` for a still-generic `M` resolves to
    // nothing with members on it, so `.value`, `.status`, `.matches()` and
    // `.getMeta()` are all errors through the narrow type; through
    // `AnyStateMachine` they resolve concretely. `M` survives where it is worth
    // having — `Flow.machine`, and `EventFromLogic<M>` on `send`, which is what
    // types an author's events.
    const logic: AnyStateMachine = machine;
    // Branched rather than passing `undefined`: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
    // absent options argument, and `createActor`'s options are conditionally
    // required.
    const actor =
      restored === undefined ? createActor(logic) : createActor(logic, { snapshot: restored });
    return actor.start();
  };

  const positionOf = (actor: ReturnType<typeof actorFor>): FlowPosition => {
    const snapshot = actor.getSnapshot();
    return {
      state: toStatePath(snapshot.value),
      done: snapshot.status === "done",
      // `exactOptionalPropertyTypes` is on, so an absent instruction has to be
      // ABSENT rather than set to `undefined` (guard-invariants rule 2).
      ...omitUndefined({ instruction: toInstruction(snapshot.getMeta()) }),
    };
  };

  /** A fresh flow's stored value: the machine's own initial snapshot. */
  const create = (): FlowState => {
    const actor = actorFor(undefined);
    try {
      return { snapshot: actor.getPersistedSnapshot() };
    } finally {
      actor.stop();
    }
  };

  const slot: SessionSlot<string, FlowState> = sessionSlot(
    key,
    create,
    omitUndefined({ durable: options.durable }),
  );

  /** Read the position without writing anything. */
  const position = (ctx: ToolContext): FlowPosition => {
    const actor = actorFor(readState(slot.get(ctx)));
    try {
      return positionOf(actor);
    } finally {
      actor.stop();
    }
  };

  /**
   * Send an event inside the slot's SYNCHRONOUS mutation window.
   *
   * There is no await between the read and the write, which is what makes two
   * concurrent flow tools in one LLM step safe — the loop runs a step's tool
   * calls concurrently, so a read-modify-write that yielded would lose one of
   * the two transitions.
   */
  const send = (ctx: ToolContext, event: EventFromLogic<M>): FlowPosition =>
    slot.update(ctx, (draft) => {
      const actor = actorFor(draft);
      try {
        actor.send(event);
        draft.snapshot = actor.getPersistedSnapshot();
        return positionOf(actor);
      } finally {
        actor.stop();
      }
    });

  const matches = (ctx: ToolContext, state: string): boolean => {
    const actor = actorFor(readState(slot.get(ctx)));
    try {
      return actor.getSnapshot().matches(state);
    } finally {
      actor.stop();
    }
  };

  return {
    key,
    machine,
    position,
    matches,
    send,
    reset: (ctx) => {
      slot.reset(ctx);
      return position(ctx);
    },
    projection: <V>(project: (position: FlowPosition) => V): StateProjection<V> =>
      // The slot's own projection resolves the value (defaulting it when the
      // session has run no tool yet), so the actor here is reading a real
      // snapshot rather than guessing at an empty frame.
      slot.projection((state) => {
        const actor = actorFor(readState(state));
        try {
          return project(positionOf(actor));
        } finally {
          actor.stop();
        }
      }),
    tool: <P extends ToolInputSchema = ToolInputSchema, R = unknown>(
      def: FlowToolDef<P, R, EventFromLogic<M>>,
    ): ToolDef<P> => {
      const allowed = typeof def.when === "string" ? [def.when] : def.when;
      for (const state of allowed) {
        if (valid.has(state)) continue;
        throw new Error(
          `Flow "${key}" has no state "${state}", so a tool gated on it could never run. Its states are: ${[...valid].sort().join(", ")}.`,
        );
      }
      if (def.send !== undefined && def.sendFrom !== undefined) {
        throw new Error(
          `A tool on flow "${key}" declares both send and sendFrom. Pick one: send for a fixed transition, sendFrom when the result decides it.`,
        );
      }
      const { execute, when: _when, send: fixed, sendFrom, ...rest } = def;
      return {
        // Spread rather than restating `inputSchema`, for the reason
        // `SessionSlot.tool` gives: rebuilding it field by field cannot preserve
        // its optionality against a still-generic `P`.
        ...rest,
        execute: (args, ctx): FlowToolResult<R> | ToolFailure => {
          const at = position(ctx);
          if (!allowed.some((state) => matches(ctx, state))) {
            // The refusal is what the model recovers from, so it says where the
            // conversation IS and what the flow expects there — not merely that
            // this was not allowed.
            const expectation = at.instruction ?? `reach ${allowed.join(" or ")} first`;
            return toolFailure(
              `Not available yet: this conversation is at "${at.state}". ${expectation}`,
            );
          }
          const result = execute(args, ctx);
          // A failed tool did not do the thing, so the flow must not move past
          // it. See FlowToolDef.send.
          if (isToolFailure(result)) return result;
          const event = sendFrom === undefined ? fixed : sendFrom(result);
          const moved = event === undefined ? at : send(ctx, event);
          return { ...moved, result };
        },
      };
    },
  };
}
