// Copyright 2026 the AAI authors. MIT license.
/**
 * `dialog()` — a dialog statechart, so what an agent may do NEXT is declared
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
 * agent — and `support-line/procedure.ts` is what that costs at the far end: 224
 * lines of hand-rolled control flow, with the node names it came from preserved
 * in a trace so a run stays readable as the procedure it used to be.
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
 * So a {@link Dialog.tool} refuses at EXECUTION: out of state it runs nothing and
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
 * A {@link Dialog.tool} answers {@link DialogToolResult} — the author's own return
 * value under `result`, wrapped in the position the dialog is in AFTER the call.
 * The shape is unconditional on purpose: a tool result is the last thing the
 * model reads before it speaks, so the current state and its instruction arrive
 * every time rather than only when an author remembered to include them. That
 * is the state-addressed prompt this design gets without a per-turn prompt,
 * which the transports cannot give it.
 *
 * @module dialog
 */

import { type AnyStateMachine, createActor, type EventFromLogic } from "xstate";
import { assertDialogGraph } from "./_dialog-graph.ts";
import {
  assertDialogSource,
  type FlowState,
  machineFromSpec,
  readState,
  statePaths,
  toInstruction,
  toStatePath,
} from "./_dialog-snapshot.ts";
import type {
  DialogEvent,
  DialogPosition,
  DialogSpec,
  DialogToolDef,
  DialogToolResult,
} from "./dialog-types.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { ToolInputSchema } from "./schema.ts";
import { type SessionSlot, sessionSlot } from "./session-slot.ts";
import type { SlotHolder, StateProjection } from "./session-state.ts";
import type { ToolDef } from "./types.ts";
import { isToolFailure, type ToolFailure, toolFailure } from "./utils.ts";

// The authoring vocabulary lives in its own module (this file was at the
// 500-line cap), and is re-exported here so that `@alexkroman1/aai` — and any
// reader who goes looking for a dialog type where `dialog()` is — still finds
// every name in one place. See `sdk/dialog-types.ts`.
export type {
  DialogEvent,
  DialogPosition,
  DialogSpec,
  DialogStateSpec,
  DialogToolDef,
  DialogToolResult,
} from "./dialog-types.ts";

/**
 * A dialog statechart bound to a session, created by {@link dialog}.
 *
 * @typeParam M - The XState machine this dialog runs.
 * @typeParam E - The event union {@link Dialog.send} and a gated tool's
 *   `send`/`sendFrom` accept. Defaults to the machine's own — a dialog declared
 *   from a {@link DialogSpec} supplies it directly instead, because the machine
 *   it builds is an implementation detail and its type carries no events.
 *
 * @public
 */
export interface Dialog<M extends AnyStateMachine, E = EventFromLogic<M>> {
  /** The store key this dialog's snapshot occupies. Two flows must not share one. */
  readonly key: string;
  /** The machine itself, for a caller that wants to inspect or visualize it. */
  readonly machine: M;
  /** Where this session's conversation currently is. */
  position(ctx: SlotHolder): DialogPosition;
  /** Whether the active state matches `state`, as `when` spells it. */
  matches(ctx: SlotHolder, state: string): boolean;
  /**
   * Advance the dialog, and store the result.
   *
   * An event the active state does not handle is IGNORED — XState's own
   * behaviour, kept rather than turned into a throw, because the alternative is
   * an agent that crashes a live call over a transition that merely was not
   * available. The returned position is what actually happened; compare its
   * `state` to know whether anything moved.
   */
  send(ctx: SlotHolder, event: E): DialogPosition;
  /** Discard this session's progress and start the dialog over. */
  reset(ctx: SlotHolder): DialogPosition;
  /**
   * Declare a tool gated on this dialog's state. See {@link DialogToolDef}.
   *
   * The return type is the WRAPPED one the body actually answers with, not a
   * bare {@link ToolDef}: `InferToolOutput<typeof myTool>` is then
   * `DialogToolResult<R> | ToolFailure`, so a custom client renders the same
   * shape the tool sends instead of `unknown`. Narrowing a return type is
   * covariant, so a gated tool is still assignable wherever the agent's
   * registry wants a `ToolDef<ToolInputSchema>`.
   */
  tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
    def: DialogToolDef<P, R, E>,
  ): ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>;
  /**
   * A `syncState` projection of this dialog's position, so a client can render
   * the step the caller is on without the agent hand-rolling a sync channel.
   *
   * The projector is REQUIRED, exactly as {@link SessionSlot.projection}'s is,
   * and for the same reason: an optional one cannot be typed without asserting
   * that the un-projected {@link DialogPosition} is the caller's `V`. Project the
   * identity — `dialog.projection((at) => at)` — to push the whole position.
   */
  projection<V>(project: (position: DialogPosition) => V): StateProjection<V>;
}

/** Options for {@link dialog}. */
export interface DialogOptions {
  /**
   * Whether this dialog's position is stored durably. Defaults to `true` — see
   * {@link SessionSlotOptions.durable}. A persisted snapshot is plain JSON by
   * construction, so there is nothing here that cannot be stored.
   */
  durable?: boolean;
}

/**
 * The success half of a settled tool body, as a type the compiler can SUBTRACT.
 *
 * The same test as {@link isToolFailure}, and it exists because NEGATING that
 * one does not subtract: the false branch of a `value is ToolFailure` test
 * leaves a generic `R | ToolFailure` exactly as it was, and `R` is not the
 * `Exclude<R, ToolFailure>` that {@link DialogToolDef.sendFrom} declares — a
 * conditional type is only assignable FROM a source assignable to BOTH its
 * branches, and nothing is assignable to `never`. A predicate's POSITIVE branch
 * can say it, so this is what lets the one call site hand `sendFrom` a narrowed
 * value with no cast. The body is still just the failure guard.
 */
function isSuccess<T>(value: T | ToolFailure): value is Exclude<T, ToolFailure> {
  return !isToolFailure(value);
}

/** The event type the implementation works in: every overload narrows it. */
type DialogEventOf = EventFromLogic<AnyStateMachine>;

/**
 * Declare a dialog statechart for an agent's conversation.
 *
 * The machine is an ordinary XState machine, so everything XState knows how to
 * do with one applies — `@xstate/procedure` can enumerate its paths to generate
 * dialog test cases, and the machine is serializable for a visualizer.
 *
 * @param key - The store key to occupy, like a {@link sessionSlot}'s. Two flows
 *   must not share one, and a dialog must not share one with a slot.
 * @param machine - The machine. Give a state a `meta.instruction` and it becomes
 *   {@link DialogPosition.instruction} while that state is active — which is what
 *   a refusal quotes and what every dialog tool's result carries.
 *
 * @example
 * ```ts
 * // shared.ts — the one place the dialog is declared.
 * import { dialog } from "@alexkroman1/aai";
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
 * export const claim = dialog("claim", machine);
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
 * @remarks
 * **Three primitives here run a defined process; pick by SCOPE.** A
 * {@link dialog} gates a CONVERSATION — what the agent may say or do next,
 * across turns, persisted in a session slot. A {@link procedure} runs ONE UNIT
 * OF WORK inside a single tool call, never stored. A {@link workflow} runs
 * DURABLY, outliving the session.
 *
 * @example
 * ```ts
 * // The same dialog as a plain state map — no `setup()`, no events union to
 * // restate, no `meta` wrapper. `dialog.send` is typed from the `on` keys.
 * import { dialog } from "@alexkroman1/aai";
 *
 * export const claim = dialog("claim", {
 *   initial: "verifying",
 *   states: {
 *     verifying: {
 *       instruction: "Get the caller's policy number and verify it.",
 *       on: { VERIFIED: "quoting" },
 *     },
 *     quoting: {
 *       instruction: "Read the excess disclosure, then quote.",
 *       on: { QUOTED: "done" },
 *     },
 *     done: { final: true },
 *   },
 * });
 * ```
 *
 * @public
 */
export function dialog<M extends AnyStateMachine>(
  key: string,
  machine: M,
  options?: DialogOptions,
): Dialog<M>;
/**
 * Declare a dialog from a plain state map — see {@link DialogSpec}.
 *
 * The overload exists rather than replacing the machine form because the two
 * answer different questions. A spec covers what every dialog in the templates
 * actually used and nothing else, on purpose: a persisted snapshot must survive
 * `structuredClone`, so guards, context and actions were never available here
 * anyway, and what an author was paying for full XState was a `setup({ types:
 * {} as { events: … } })` block restating the event names already written in the
 * `on` maps. A dialog that needs more than the spec can say passes a machine,
 * and that path is unchanged.
 *
 * It builds the same machine, so the STORED SNAPSHOT is byte-identical to the
 * hand-written equivalent's and a `durable: true` dialog resumes across the
 * switch — see `machineFromSpec`.
 *
 * @public
 */
export function dialog<const S extends DialogSpec>(
  key: string,
  spec: S,
  options?: DialogOptions,
): Dialog<AnyStateMachine, DialogEvent<S>>;
export function dialog(
  key: string,
  source: AnyStateMachine | DialogSpec,
  options: DialogOptions = {},
): Dialog<AnyStateMachine> {
  // Before the `in` test, because `dialog(spec)` — the one-argument shape every
  // other authoring function in this SDK takes — lands here with `source`
  // undefined and used to die on `Cannot use 'in' operator to search for
  // 'transition' in undefined`, from a stack naming neither `dialog` nor the
  // missing key.
  assertDialogSource(source);
  // `in` on the union rather than a shape test for `states`: BOTH have one, and
  // only the machine has behaviour. Machine-first in the overload list for the
  // same reason — a plain object cannot satisfy `AnyStateMachine`, where a
  // machine could be read as a spec.
  const machine = "transition" in source ? source : machineFromSpec(key, source);
  const valid = statePaths(machine);
  assertDialogGraph(key, machine, valid);

  /**
   * A started actor for this session's stored snapshot.
   *
   * Started fresh per call rather than cached per session, and that is the
   * design: an actor is a LIVE object with subscriptions behind it, so caching
   * one would make the dialog's lifetime the process's rather than the session's —
   * and a session outlives the process it started in (it survives a disconnect
   * through the resume grace window, and on the platform it can resume in a
   * different sandbox entirely). The snapshot is the state; the actor is a
   * short-lived reader of it, and every caller here stops the one it made.
   */
  const actorFor = (state: FlowState | undefined) => {
    const restored = state?.snapshot;
    // `AnyStateMachine` throughout the BODY, deliberately. A still-generic `M`
    // resolves `SnapshotFrom<M>` to nothing with members on it, so `.value`,
    // `.status`, `.matches()` and `.getMeta()` are all errors through the narrow
    // type; through `AnyStateMachine` they resolve concretely. `M` survives in
    // the OVERLOADS, which is where it is worth having — `Dialog.machine`, and
    // `EventFromLogic<M>` on `send`, which is what types an author's events.
    const logic: AnyStateMachine = machine;
    // Branched rather than passing `undefined`: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
    // absent options argument, and `createActor`'s options are conditionally
    // required.
    const actor =
      restored === undefined ? createActor(logic) : createActor(logic, { snapshot: restored });
    return actor.start();
  };

  const positionOf = (actor: ReturnType<typeof actorFor>): DialogPosition => {
    const snapshot = actor.getSnapshot();
    return {
      state: toStatePath(snapshot.value),
      done: snapshot.status === "done",
      // `exactOptionalPropertyTypes` is on, so an absent instruction has to be
      // ABSENT rather than set to `undefined` (guard-invariants rule 2).
      ...omitUndefined({ instruction: toInstruction(snapshot.getMeta()) }),
    };
  };

  /** A fresh dialog's stored value: the machine's own initial snapshot. */
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
  const position = (ctx: SlotHolder): DialogPosition => {
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
   * concurrent dialog tools in one LLM step safe — the loop runs a step's tool
   * calls concurrently, so a read-modify-write that yielded would lose one of
   * the two transitions.
   */
  const send = (ctx: SlotHolder, event: DialogEventOf): DialogPosition =>
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

  const matches = (ctx: SlotHolder, state: string): boolean => {
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
    projection: <V>(project: (position: DialogPosition) => V): StateProjection<V> =>
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
      def: DialogToolDef<P, R, DialogEventOf>,
    ): ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>> => {
      const allowed = typeof def.when === "string" ? [def.when] : def.when;
      for (const state of allowed) {
        if (valid.has(state)) continue;
        throw new Error(
          `Dialog "${key}" has no state "${state}", so a tool gated on it could never run. Its states are: ${[...valid].sort().join(", ")}.`,
        );
      }
      if (def.send !== undefined && def.sendFrom !== undefined) {
        throw new Error(
          `A tool on dialog "${key}" declares both send and sendFrom. Pick one: send for a fixed transition, sendFrom when the result decides it.`,
        );
      }
      const { execute, when: _when, send: fixed, sendFrom, ...rest } = def;
      return {
        // Spread rather than restating `inputSchema`, for the reason
        // `SessionSlot.tool` gives: rebuilding it field by field cannot preserve
        // its optionality against a still-generic `P`.
        ...rest,
        // ASYNC, and it has to be: a voice tool routinely awaits a model call or
        // an HTTP request, and the failure check and the transition both read
        // the SETTLED value. A synchronous version tested `isToolFailure` on a
        // pending promise (always false) and handed that promise to `sendFrom`,
        // so an async tool that failed advanced the dialog anyway — the one bug
        // this primitive most needs not to have.
        execute: async (args, ctx): Promise<DialogToolResult<R> | ToolFailure> => {
          // The gate is read BEFORE the body runs, which is the moment that
          // matters: it is what the caller's turn is allowed to do.
          const at = position(ctx);
          if (!allowed.some((state) => matches(ctx, state))) {
            // The refusal is what the model recovers from, so it says where the
            // conversation IS and what the dialog expects there — not merely that
            // this was not allowed.
            const expectation = at.instruction ?? `reach ${allowed.join(" or ")} first`;
            return toolFailure(
              `Not available yet: this conversation is at "${at.state}". ${expectation}`,
            );
          }
          // ANNOTATED rather than inferred: `await` on `R | ToolFailure |
          // Promise<R | ToolFailure>` yields `Awaited<R> | ToolFailure`, and
          // `Awaited<R>` is not the `Exclude<R, ToolFailure>` that `sendFrom`
          // now promises its parameter is. The annotation settles that once,
          // where the alternative is a cast at the one call.
          const result: R | ToolFailure = await execute(args, ctx);
          // A failed tool did not do the thing, so the dialog must not move past
          // it. See DialogToolDef.send.
          if (isToolFailure(result)) return result;
          // `isSuccess` is that same test stated as a SUBTRACTION, and it is
          // always true here — the failure returned on the line above. What the
          // call buys is the narrowing from `R` to `Exclude<R, ToolFailure>`
          // that `sendFrom`'s parameter now promises, which the NEGATION of a
          // predicate cannot give a generic. See `isSuccess`. `fixed` is
          // `undefined` whenever `sendFrom` is not, so the two arms cannot both
          // contribute an event (declaring both throws at declaration).
          const event = sendFrom !== undefined && isSuccess(result) ? sendFrom(result) : fixed;
          // Re-READ rather than reusing `at` when nothing is sent: the LLM loop
          // runs a step's tool calls concurrently, so a sibling may have moved
          // the dialog while this body was awaiting, and reporting the position
          // this call started at would describe a conversation that has moved on.
          const moved = event === undefined ? position(ctx) : send(ctx, event);
          return { ...moved, result };
        },
      };
    },
  };
}
