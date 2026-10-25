// Copyright 2026 the AAI authors. MIT license.
/**
 * What `dialog()` hands BACK: the handle a `tools/` module, an `events` handler
 * and the runtime all hold.
 *
 * Split from `sdk/dialog-types.ts` when that file reached the 500-line cap, and
 * the seam is the one the two halves already had: that module is what an author
 * DECLARES (a state map, a gated tool's shape, the per-state voice settings),
 * and this is the object those declarations produce. The line is worth keeping
 * even though both are types — the declaration half is read while writing an
 * `agent.ts`, and this half is read while writing the code that drives one.
 *
 * Both are re-exported by `sdk/dialog.ts` and so by `@alexkroman1/aai`: no
 * import moved, and none should have to.
 *
 * @module dialog-handle
 */

import type {
  DialogPosition,
  DialogSendOptions,
  DialogTimeout,
  DialogToolDef,
  DialogToolResult,
  DialogVoiceConfig,
} from "./dialog-types.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { SessionEvent } from "./session-event-map.ts";
import type { SlotHolder, StateProjection } from "./session-state.ts";
import type { ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

/**
 * The machine behind a dialog, as the SDK names it: an XState machine handed to
 * `dialog(key, machine)`, or the one a {@link DialogSpec} compiles to.
 *
 * The SDK's own STRUCTURAL type rather than XState's `AnyStateMachine`, so
 * XState's types stay out of the published contract — an XState upgrade is not
 * an SDK break. Any XState machine satisfies it, and `E` is inferred from the
 * machine's own events.
 *
 * @typeParam E - The events the machine accepts.
 *
 * @input
 * @public
 */
export interface DialogMachine<E extends { type: string } = { type: string }> {
  readonly id: string;
  transition(snapshot: never, event: E, actorScope: never): unknown;
}

/**
 * A dialog statechart bound to a session, created by {@link dialog}.
 *
 * @typeParam E - The event union {@link Dialog.send} and a gated tool's
 *   `send`/`sendFrom` accept: the machine's own events for the machine form,
 *   or the names a {@link DialogSpec}'s `on` maps spell.
 *
 * @sealed
 * @public
 */
export interface Dialog<E = { type: string }> {
  /** The store key this dialog's snapshot occupies. Two flows must not share one. */
  readonly key: string;
  /**
   * The machine itself, for a caller that wants to inspect or visualize it —
   * an XState machine, typed `unknown` so XState's types stay off the contract:
   * `dialog.machine as AnyStateMachine`.
   */
  readonly machine: unknown;
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
  /**
   * Offer a SESSION event to the dialog: the runtime's half of
   * {@link DialogSessionEventName}.
   *
   * Sends `{ type: "@<event.type>" }` when the active state (or a state
   * containing it) declares a transition on it, and does nothing at all
   * otherwise — the position comes back either way, so a caller that wants to
   * know whether anything moved compares `state`. XState already ignores an
   * unhandled event, so the check is not what makes this safe; what it buys is
   * that the overwhelming majority of session events, which no dialog is
   * watching, write nothing. A send stores the snapshot whether or not the
   * machine moved, so on a `durable` dialog that would be a store round-trip per
   * transcript frame.
   *
   * The runtime calls this for a dialog listed in {@link AgentDeclaration.dialogs}. It
   * takes a {@link SlotHolder}, which is what a `SessionEventContext` already
   * is — both carry `slots` and `sessionId` — so an author can drive a dialog
   * from an `events` handler today, with no declaration at all:
   *
   * ```ts
   * import { agent, dialog } from "@alexkroman1/aai";
   *
   * const claim = dialog("claim", {
   *   initial: "verifying",
   *   states: {
   *     verifying: { on: { "@session.timedOut": "abandoned" } },
   *     abandoned: { final: true },
   *   },
   * });
   *
   * export default agent({
   *   name: "Support",
   *   events: { "session.timedOut": (event, ctx) => void claim.receive(ctx, event) },
   * });
   * ```
   */
  receive(ctx: SlotHolder, event: SessionEvent): DialogPosition;
  /**
   * The deadline declared where the conversation currently is, if any — read
   * from the DEEPEST active state, exactly as {@link DialogPosition.instruction}
   * is.
   *
   * A READ, not a timer: nothing here is armed, and calling this has no effect
   * on the dialog. The runtime asks once per turn and arms its own deadline;
   * anything that fires the returned `event` back through {@link Dialog.send}
   * gets the transition the state declared.
   */
  timeout(ctx: SlotHolder): DialogTimeout | undefined;
  /**
   * The voice settings declared where the conversation currently is, if any —
   * deepest active state wins, and a parent contributes nothing to a config a
   * child declares. See {@link DialogVoiceConfig}.
   */
  voiceConfig(ctx: SlotHolder): DialogVoiceConfig | undefined;
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
   *
   * The optional second argument carries `sendFrom` for a tool whose def
   * cannot order it below an inline `execute` — see {@link DialogSendOptions}.
   * A `send`/`sendFrom` in both places is refused at declaration.
   */
  tool<P extends ToolInputSchema | undefined = ToolInputSchema, R = unknown>(
    def: DialogToolDef<P, R, E>,
    options?: DialogSendOptions<R, E>,
  ): ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>;
  /**
   * A `syncState` projection of this dialog's position, so a client can render
   * the step the caller is on without the agent hand-rolling a sync channel.
   *
   * The projector is REQUIRED: an optional one cannot be typed without
   * asserting that the un-projected {@link DialogPosition} is the caller's `V`.
   * Project the identity — `dialog.projection((at) => at)` — to push the whole
   * position.
   */
  projection<V>(project: (position: DialogPosition) => V): StateProjection<V>;
}

/**
 * Any dialog, whatever its machine and event union — what
 * {@link AgentDeclaration.dialogs} holds.
 *
 * The erasure is on `E` and it is what makes the array possible at all: two
 * dialogs in one agent have different event unions by construction (the names
 * come from their own `on` maps), so `readonly Dialog[]` would be a list nothing
 * but a dialog with the default parameter could join. `unknown` rather than `any` because every member that takes an `E` is
 * declared with METHOD syntax, whose parameters are compared bivariantly — so a
 * `Dialog<{ type: "VERIFIED" }>` is assignable here without spending an
 * escape hatch on it, and the runtime, which only ever calls the members that
 * take no event (`receive`, `timeout`, `voiceConfig`, `position`), never has an
 * `any` to hand something.
 *
 * @public
 */
export type AnyDialog = Dialog<unknown>;

/**
 * Options for {@link dialog}.
 *
 * @input
 */
export interface DialogOptions {
  /**
   * Whether this dialog's position is stored durably. Defaults to `true` — see
   * {@link SessionSlotOptions.durable}. A persisted snapshot is plain JSON by
   * construction, so there is nothing here that cannot be stored.
   */
  durable?: boolean;
}
