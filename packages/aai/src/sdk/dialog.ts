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
 * agent — and `technical-support-agent/procedure.ts` is what that costs at the far end: 224
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
 * the call answers a `ToolRefusal` (`reason: "dialog"`) naming where the
 * conversation is and what has to happen first. The check is inside the minted
 * def's own `execute`, so it travels with the def and holds identically on all
 * three transports, in a subagent and in a spec. A schema gate would have hidden the tool and left the model
 * guessing. The body does not run; the model may still call early, be refused,
 * and be told what to do — the intended loop.
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

import {
  type AnyStateMachine,
  createActor,
  type EventFromLogic,
  type InspectionEvent,
} from "xstate";
import {
  assertDialogSessionEvents,
  assertDialogTimeouts,
  assertNoDelayedTransitions,
  assertNoSpecDelays,
  toDialogEventType,
} from "./_dialog-events.ts";
import { compileDialogGate } from "./_dialog-gate.ts";
import { assertDialogGraph } from "./_dialog-graph.ts";
import { toInstruction, toPersona, toTimeout, toVoiceConfig } from "./_dialog-meta.ts";
import {
  assertDialogSource,
  ENTER_ACTION,
  entryHooks,
  type FlowState,
  machineFromSpec,
  readState,
  statePaths,
  toStatePath,
} from "./_dialog-snapshot.ts";
import type { Dialog, DialogMachine, DialogOptions } from "./dialog-handle.ts";
import type {
  DialogEvent,
  DialogPosition,
  DialogSendOptions,
  DialogSpec,
  DialogTimeout,
  DialogToolDef,
  DialogToolResult,
  DialogVoiceConfig,
} from "./dialog-types.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { SessionEvent } from "./session-event-map.ts";
import { type SessionSlot, sessionSlot } from "./session-slot.ts";
import type { SlotHolder, StateProjection } from "./session-state.ts";
import type { ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

// The authoring vocabulary lives in its own two modules (this file was at the
// 500-line cap, and `dialog-types.ts` reached it in turn), and every name is
// re-exported here so that `@alexkroman1/aai` — and any reader who goes looking
// for a dialog type where `dialog()` is — still finds them in one place. See
// `sdk/dialog-types.ts` for what an author DECLARES and `sdk/dialog-handle.ts`
// for what this function hands back.
export type {
  AnyDialog,
  Dialog,
  DialogMachine,
  DialogOptions,
} from "./dialog-handle.ts";
export type {
  DialogEvent,
  DialogEventNames,
  DialogGate,
  DialogPosition,
  DialogSendFrom,
  DialogSendFromKey,
  DialogSendOptions,
  DialogSessionEventName,
  DialogSpec,
  DialogStateSpec,
  DialogTimeout,
  DialogTimeoutSpec,
  DialogToolDef,
  DialogToolResult,
  DialogVoiceConfig,
  EventNameOf,
} from "./dialog-types.ts";

/** The event type the implementation works in: every overload narrows it. */
type DialogEventOf = EventFromLogic<AnyStateMachine>;

/**
 * The state path an {@link ENTER_ACTION} inspection event names, or `undefined`
 * for every other event on the stream.
 */
function enteredPath(event: InspectionEvent): string | undefined {
  if (event.type !== "@xstate.action" || event.action.type !== ENTER_ACTION) return undefined;
  const params: unknown = event.action.params;
  return isRecord(params) && typeof params.path === "string" ? params.path : undefined;
}

/**
 * Declare a dialog statechart for an agent's conversation.
 *
 * The machine is an ordinary XState machine, so everything XState knows how to
 * do with one applies — `@xstate/graph` can enumerate its paths to generate
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
export function dialog<E extends { type: string }>(
  key: string,
  machine: DialogMachine<E>,
  options?: DialogOptions,
): Dialog<E>;
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
): Dialog<DialogEvent<S>>;
export function dialog(
  key: string,
  source: DialogMachine | DialogSpec,
  options: DialogOptions = {},
): Dialog {
  // Before the `in` test, because `dialog(spec)` — the one-argument shape every
  // other authoring function in this SDK takes — lands here with `source`
  // undefined and used to die on `Cannot use 'in' operator to search for
  // 'transition' in undefined`, from a stack naming neither `dialog` nor the
  // missing key.
  assertDialogSource(source);
  // BEFORE the machine is built, because `toNodes` copies the fields it knows
  // and drops the rest: an `after` in a spec would reach no machine at all, and
  // the state it was supposed to leave would be reported by the graph guard as
  // wedged — a message about a missing event, for an author who wrote a delay.
  if (!("transition" in source)) assertNoSpecDelays(key, source);
  // `in` on the union rather than a shape test for `states`: BOTH have one, and
  // only the machine has behaviour. Machine-first in the overload list for the
  // same reason — a plain object cannot satisfy `AnyStateMachine`, where a
  // machine could be read as a spec.
  // The machine form is an XState machine by contract (`DialogMachine` is its
  // structural, XState-free name), so the cast restores the type the body reads.
  const machine: AnyStateMachine =
    "transition" in source ? (source as AnyStateMachine) : machineFromSpec(key, source);
  // Before the graph guard, which reads the transitions XState desugars `after`
  // INTO and would therefore call a delay-only state perfectly healthy — the
  // exact reason a dialog could declare a transition that can never fire.
  assertNoDelayedTransitions(key, machine);
  const valid = statePaths(machine);
  assertDialogGraph(key, machine, valid);
  // After the graph, because an unreachable or wedged state is the more
  // fundamental defect and its message should be the one an author sees first.
  assertDialogSessionEvents(key, machine);
  assertDialogTimeouts(key, machine);
  // The spec form's `onEnter` hooks, by state path; a machine declares none
  // here (XState's own `entry` is its mechanism).
  const hooks = "transition" in source ? new Map<string, never>() : entryHooks(source);

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
   *
   * @param entered - Where `send` collects the states the actor ENTERS, read
   *   off XState's inspection stream; a reader passes nothing.
   */
  const actorFor = (state: FlowState | undefined, entered?: string[]) => {
    // `AnyStateMachine` throughout the BODY, deliberately. A still-generic `M`
    // resolves `SnapshotFrom<M>` to nothing with members on it, so `.value`,
    // `.status`, `.matches()` and `.getMeta()` are all errors through the narrow
    // type; through `AnyStateMachine` they resolve concretely. `M` survives in
    // the OVERLOADS, which is where it is worth having — `Dialog.machine`, and
    // `EventFromLogic<M>` on `send`, which is what types an author's events.
    const logic: AnyStateMachine = machine;
    // `omitUndefined` rather than a branch per option: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as
    // an absent option (guard-invariants rule 2).
    const inspect =
      entered === undefined
        ? undefined
        : (event: InspectionEvent): void => {
            const path = enteredPath(event);
            if (path !== undefined) entered.push(path);
          };
    return createActor(logic, omitUndefined({ snapshot: state?.snapshot, inspect })).start();
  };

  const positionOf = (actor: ReturnType<typeof actorFor>): DialogPosition => {
    const snapshot = actor.getSnapshot();
    return {
      state: toStatePath(snapshot.value),
      done: snapshot.status === "done",
      // `exactOptionalPropertyTypes` is on, so an absent instruction has to be
      // ABSENT rather than set to `undefined` (guard-invariants rule 2).
      ...omitUndefined({
        instruction: toInstruction(snapshot.getMeta()),
        persona: toPersona(snapshot.getMeta()),
      }),
    };
  };

  /**
   * Read `state` through a started actor and stop it again.
   *
   * The `try`/`finally` is the whole invariant `actorFor` states — "every caller
   * here stops the one it made" — so it is written once rather than at each of
   * the five readers.
   */
  const withActor = <T>(
    state: FlowState | undefined,
    use: (a: ReturnType<typeof actorFor>) => T,
  ): T => {
    const actor = actorFor(state);
    try {
      return use(actor);
    } finally {
      actor.stop();
    }
  };

  /** A fresh dialog's stored value: the machine's own initial snapshot. */
  const create = (): FlowState =>
    withActor(undefined, (a) => ({ snapshot: a.getPersistedSnapshot() }));

  const slot: SessionSlot<string, FlowState> = sessionSlot(
    key,
    create,
    omitUndefined({ durable: options.durable }),
  );

  /** Read the position without writing anything. */
  const position = (ctx: SlotHolder): DialogPosition =>
    withActor(readState(slot.get(ctx)), positionOf);

  /**
   * Send an event inside the slot's SYNCHRONOUS mutation window.
   *
   * There is no await between the read and the write, which is what makes two
   * concurrent dialog tools in one LLM step safe — the loop runs a step's tool
   * calls concurrently, so a read-modify-write that yielded would lose one of
   * the two transitions.
   *
   * The `onEnter` hooks run in the same window, after the new snapshot is on
   * the draft, in the order XState entered the states — so a hook that throws
   * discards the move along with its own effects on the stored value. A
   * restored snapshot runs no entry action, so nothing re-fires on a read.
   */
  const send = (ctx: SlotHolder, event: DialogEventOf): DialogPosition =>
    slot.update(ctx, (draft) => {
      const entered: string[] = [];
      const actor = actorFor(draft, entered);
      try {
        actor.send(event);
        draft.snapshot = actor.getPersistedSnapshot();
        const at = positionOf(actor);
        for (const path of entered) hooks.get(path)?.(ctx);
        return at;
      } finally {
        actor.stop();
      }
    });

  const matches = (ctx: SlotHolder, state: string): boolean =>
    withActor(readState(slot.get(ctx)), (a) => a.getSnapshot().matches(state));

  const handle: Dialog = {
    key,
    machine,
    position,
    matches,
    send,
    /**
     * Offer a session event, and send it only if something is listening.
     *
     * Two actors on the moving path (one to ask, one inside `send`'s mutation
     * window) rather than one, and the asymmetry is the point: a session emits
     * transcript and speech frames continuously, almost none of which any dialog
     * declares, and `slot.update` writes UNCONDITIONALLY — it stores the draft
     * when the mutator returns, whether or not the machine moved. So sending
     * every event would re-serialize and commit a `durable` dialog's snapshot on
     * every frame of a call. A read materializes the slot's default once and
     * writes nothing after that. `can()` is XState's own answer to "would this
     * event do anything here", so a transition declared on an ancestor counts
     * exactly as it would for `send`.
     */
    receive: (ctx, event: SessionEvent): DialogPosition => {
      const type = toDialogEventType(event.type);
      const handled = withActor(readState(slot.get(ctx)), (a) => a.getSnapshot().can({ type }));
      return handled ? send(ctx, { type }) : position(ctx);
    },
    // Both are pure READS of the state the dialog is in — nothing is armed and
    // nothing is applied here. The runtime asks per turn and does both.
    timeout: (ctx): DialogTimeout | undefined =>
      withActor(readState(slot.get(ctx)), (a) => toTimeout(a.getSnapshot().getMeta())),
    voiceConfig: (ctx): DialogVoiceConfig | undefined =>
      withActor(readState(slot.get(ctx)), (a) => toVoiceConfig(a.getSnapshot().getMeta())),
    reset: (ctx) => {
      slot.reset(ctx);
      return position(ctx);
    },
    projection: <V>(project: (position: DialogPosition) => V): StateProjection<V> =>
      // The stored value, or the machine's own initial snapshot when the
      // session has run no tool yet, so the actor here is reading a real
      // snapshot rather than guessing at an empty frame. `create` rather than
      // a captured default, for the reason `sessionSlot`'s projection gives.
      Object.assign(
        (value?: unknown): V =>
          withActor(readState(value ?? create()), (a) => project(positionOf(a))),
        { key, create: create as () => unknown },
      ),
    tool: <P extends ToolInputSchema | undefined = ToolInputSchema, R = unknown>(
      def: DialogToolDef<P, R, DialogEventOf>,
      options?: DialogSendOptions<R, DialogEventOf>,
    ): ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>> => {
      // The gate halves — the refusal, the failure rule, the sibling re-check
      // and the envelope — are `_dialog-gate.ts`, shared with a slot tool that
      // carries a `dialog`. Compiled at declaration, where `when` is checked.
      const gate = compileDialogGate(handle, def, options);
      const {
        execute,
        when: _when,
        send: _send,
        sendFrom: _sendFrom,
        reset: _reset,
        ...rest
      } = def;
      const minted: ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>> = {
        // Spread rather than restating `inputSchema`, for the reason
        // `SessionSlot.tool` gives: rebuilding it field by field cannot preserve
        // its optionality against a still-generic `P`. `onError` and `messages` ride it too,
        // which is what makes a gated tool classifiable like any other — see
        // `DialogToolDef`'s doc for what a handled throw does NOT do (carry
        // the envelope, move the dialog).
        ...rest,
        // ASYNC, and it has to be: a voice tool routinely awaits a model call or
        // an HTTP request, and the failure check and the transition both read
        // the SETTLED value. A synchronous version tested `isToolFailure` on a
        // pending promise (always false) and handed that promise to `sendFrom`,
        // so an async tool that failed advanced the dialog anyway — the one bug
        // this primitive most needs not to have.
        execute: async (args, ctx): Promise<DialogToolResult<R> | ToolFailure> => {
          // Read BEFORE the body runs — what the caller's turn is allowed to do.
          const refused = gate.refuse(ctx);
          if (refused) return refused;
          // ANNOTATED rather than inferred: `await` on `R | ToolFailure |
          // Promise<R | ToolFailure>` yields `Awaited<R> | ToolFailure`, and
          // `Awaited<R>` is not the `R` the envelope promises. The annotation
          // settles that once, where the alternative is a cast at the one call.
          const result: R | ToolFailure = await execute(args, ctx);
          return gate.settle(ctx, result);
        },
      };
      return minted;
    },
  };
  return handle;
}
