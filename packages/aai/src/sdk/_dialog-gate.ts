// Copyright 2026 the AAI authors. MIT license.
/**
 * The two halves of a gated tool call, as ONE compiled object: the refusal
 * before the body, and the transition and envelope after it.
 *
 * `dialog.tool` used to hold both inline. A slot-backed tool that carries a
 * `dialog` (see `SlotDialogGate`) runs exactly the same halves around its own
 * read or update window, so they are built here once and both callers
 * delegate — the rule that nothing is sent on a {@link ToolFailure}, the
 * sibling re-check before the send, the envelope's shape, all live in one
 * place and cannot drift between the two.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `dialog.tool` and `SessionSlot.tool`/`updateTool`
 * are the public surface.
 *
 * @module _dialog-gate
 */

import type { AnyStateMachine } from "xstate";
import { type DialogReading, readDialog } from "./_dialog-reader.ts";
import { dialogRefusalMessage } from "./_dialog-refusal.ts";
import { statePaths } from "./_dialog-snapshot.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import type { DialogToolResult } from "./dialog-types.ts";
import { isRecord } from "./is-record.ts";
import type { SlotHolder } from "./session-state.ts";
import { INSTRUCTION_KEY, instructionOf, stripInstruction } from "./tool-instruction.ts";
import { isToolFailure, type ToolFailure, type ToolRefusal, toolRefusal } from "./utils.ts";

/** An event as the gate sends it: the machine form's `EventObject`. */
export type GateEvent = { readonly type: string };

/**
 * A function type whose parameters are compared BIVARIANTLY, as a method's
 * are — the standard `bivarianceHack` spelling.
 *
 * The erased shapes below are what an author's typed def is handed to as:
 * `(result: Order) => …` must be accepted where the implementation can only
 * say `(result: unknown) => …`, and a property-typed function compares its
 * parameters contravariantly, which refuses exactly that. A method does not,
 * and this reads a method's signature back out as a type — no cast at the
 * call, no `never`-typed parameter.
 */
export type Bivariant<A extends unknown[], R> = { call(...args: A): R }["call"];

/**
 * A gate as the implementation reads it, every type parameter erased.
 *
 * The string arm of `sendFrom` is the field-name form.
 */
export type ErasedGate = {
  readonly when?: string | readonly string[] | undefined;
  readonly send?: GateEvent | undefined;
  readonly sendFrom?: Bivariant<[result: unknown], GateEvent | undefined> | string | undefined;
  readonly reset?: true | undefined;
};

/** The second-argument form of `sendFrom`, erased the same way. */
export type ErasedSendOptions = { readonly sendFrom: NonNullable<ErasedGate["sendFrom"]> };

/** What a gated call runs around its body. */
export type CompiledGate = {
  /**
   * The refusal for a call made where `when` does not allow it, or `undefined`
   * when the body may run. The ONE gate: every path — the runtime, a subagent,
   * a spec — runs it.
   */
  refuse(ctx: SlotHolder): ToolRefusal | undefined;
  /**
   * Start the dialog over, when `reset` was declared — called once every
   * setup stage (`require`, `prepare`) has passed and right before the body,
   * so a tool that fails in its setup leaves the conversation where it was.
   * Nothing otherwise.
   */
  enter(ctx: SlotHolder): void;
  /**
   * The event the settled result decides, or `undefined` to stay put — and
   * for a {@link ToolFailure}, always `undefined`, since nothing is sent on
   * one. Separate from {@link CompiledGate.settle} so a caller with a
   * mutation window can decide INSIDE it: a field-name `sendFrom` whose field
   * holds no event name throws here, and inside the window that throw
   * discards the draft instead of leaving a stored mutation behind a tool the
   * model was told failed.
   */
  decide(result: unknown): GateEvent | undefined;
  /**
   * The body's settled result as the tool answers it: a failure unchanged and
   * nothing sent; a success wrapped in the position after the transition. A
   * `withInstruction` the body attached is LIFTED onto the envelope — the
   * runtime reads `$instruction` off whatever a tool returned, so one buried
   * under `result` would reach neither the model nor the stripper.
   *
   * @param event - What {@link CompiledGate.decide} answered for `result`.
   */
  settle<S>(
    ctx: SlotHolder,
    result: S | ToolFailure,
    event: GateEvent | undefined,
  ): DialogToolResult<S> | ToolFailure;
};

/**
 * Validate a gate at DECLARATION and compile it against a dialog.
 *
 * @param dialog - The dialog the gate is on; its machine supplies the state set
 *   `when` is checked against.
 * @param gate - The gate fields off the tool's def.
 * @param options - The second-argument `sendFrom`, if the call passed one.
 */
export function compileDialogGate(
  dialog: AnyDialog,
  gate: ErasedGate,
  options: ErasedSendOptions | undefined,
): CompiledGate {
  const { key } = dialog;
  // Every `DialogMachine` is an XState machine (see its doc), which is what
  // `statePaths` walks; the handle types it `unknown` to keep XState's types
  // off the contract.
  const valid = statePaths(dialog.machine as AnyStateMachine);
  const allowed = typeof gate.when === "string" ? [gate.when] : gate.when;
  for (const state of allowed ?? []) {
    if (valid.has(state)) continue;
    throw new Error(
      `Dialog "${key}" has no state "${state}", so a tool gated on it could never run. Its states are: ${[...valid].sort().join(", ")}.`,
    );
  }
  const declared = [gate.send, gate.sendFrom, options?.sendFrom].filter((x) => x !== undefined);
  if (declared.length > 1) {
    throw new Error(
      `A tool on dialog "${key}" declares more than one of send, sendFrom and a second-argument sendFrom. Pick one: send for a fixed transition, sendFrom when the result decides it.`,
    );
  }
  const sendFrom = options?.sendFrom ?? gate.sendFrom;

  /** The event the settled success value decides, or `undefined` to stay put. */
  const eventFor = (result: unknown): GateEvent | undefined => {
    if (sendFrom === undefined) return gate.send;
    if (typeof sendFrom === "function") return sendFrom(result);
    // The field-name form. The type admits only a field holding an event name
    // or nothing; an UNTYPED caller can still hand it anything, and a silent
    // no-send would leave the conversation a step behind with no symptom.
    const value = isRecord(result) ? result[sendFrom] : undefined;
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return { type: value };
    throw new Error(
      `A tool on dialog "${key}" declares sendFrom: "${sendFrom}", but its result's "${sendFrom}" field holds ${typeof value}, not an event name.`,
    );
  };

  // One read per call — position and the `when` test off one actor
  // (`_dialog-reader.ts`), not one actor per allowed state.
  const here = (at: DialogReading): boolean =>
    allowed === undefined || allowed.some((state) => at.matches(state));

  return {
    refuse: (ctx) => {
      // The refusal says where the conversation IS and what it expects there —
      // what the model recovers from.
      const at = readDialog(dialog, ctx);
      if (here(at)) return;
      const expectation = at.position.instruction ?? `Reach ${(allowed ?? []).join(" or ")} first.`;
      return toolRefusal("dialog", dialogRefusalMessage(at.position.state, expectation));
    },
    // AFTER the gate and the setup stages: `when` describes the position the
    // call was made in, and a `require`/`prepare` failure is a tool that did
    // not run, which must not restart the conversation either.
    enter: (ctx) => {
      if (gate.reset === true) dialog.reset(ctx);
    },
    // A failed tool did not do the thing, so the dialog must not move past
    // it. See DialogGate.send.
    decide: (result) => (isToolFailure(result) ? undefined : eventFor(result)),
    settle: (ctx, result, event) => {
      if (isToolFailure(result)) return result;
      // A step's tool calls run CONCURRENTLY, so a sibling may have moved the
      // dialog during the body. The gate is RE-CHECKED (synchronously, right
      // before the send) so the event cannot fire a transition out of a state
      // this tool was never allowed in — see `DialogGate.when` — and the
      // position is re-READ, since the one at the refusal may describe a
      // conversation moved on. Not under `reset`: the send was declared for
      // the dialog this tool just started over, which `when` (checked on the
      // position BEFORE the reset) says nothing about.
      const at = readDialog(dialog, ctx);
      const moved =
        event === undefined || (gate.reset !== true && !here(at))
          ? at.position
          : dialog.send(ctx, event);
      // The instruction travels on the ENVELOPE, where the runtime looks.
      const instruction = instructionOf(result);
      if (instruction === undefined) return { ...moved, result };
      return {
        ...moved,
        result: stripInstruction(result) as typeof result,
        [INSTRUCTION_KEY]: instruction,
      };
    },
  };
}
