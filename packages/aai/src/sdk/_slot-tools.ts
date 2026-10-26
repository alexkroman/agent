// Copyright 2026 the AAI authors. MIT license.
/**
 * The tool builders behind `SessionSlot.tool`, `SessionSlot.updateTool` and
 * `SessionSlot.transact` — the one pipeline every slot-backed tool is a
 * selection of stages from.
 *
 * In order: the dialog refusal (`dialog`), `require` on the frozen value, the
 * async `prepare` with a second `require` behind it, the dialog's `reset`,
 * the synchronous window (the body, then the slot's `after` and `caps`, then
 * `report` on the value about to be stored and the gate's decision), and the
 * dialog's transition with its envelope. Each stage
 * is optional and the order is fixed, which is what lets the handle's four
 * `updateTool` overloads be one function here: a def declares the stages it
 * wants and the rest are skipped.
 *
 * Split out of `sdk/session-slot.ts` so that file stays the slot's STORAGE —
 * reads, writes, the draft window, the projection — and this one is what a
 * tool does around it. The gate halves themselves are `_dialog-gate.ts`,
 * shared with `dialog.tool`.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `sessionSlot()` is the public surface.
 *
 * @module _slot-tools
 */

import {
  type Bivariant,
  type CompiledGate,
  compileDialogGate,
  type ErasedGate,
  type ErasedSendOptions,
  type GateEvent,
} from "./_dialog-gate.ts";
import type { DeepReadonly } from "./deep-readonly.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import { isThenable } from "./is-thenable.ts";
import type { SlotTransaction } from "./session-slot-types.ts";
import type { SlotHolder } from "./session-state.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure, type ToolFailure } from "./utils.ts";

/** What the builders need of a slot: its key, a frozen read, and the window. */
export type SlotCore<T> = {
  readonly key: string;
  get(ctx: SlotHolder): DeepReadonly<T>;
  /**
   * The mutation window, with an optional second step run INSIDE it on the
   * value about to be stored — after the slot's `after` hook and `caps`, before
   * the write — whose return is the window's result and whose throw discards
   * the draft like the mutator's own. `report` runs there, so a failure it
   * returns stores nothing.
   */
  update<R, R2 = R>(
    ctx: SlotHolder,
    mutate: (draft: T) => R,
    finish?: (stored: DeepReadonly<T>, result: R) => R2,
  ): R2;
};

/** The args a built tool is called with — validated upstream, untyped here. */
type Args = Record<string, unknown>;

/**
 * The stages every slot tool may declare, with the type parameters erased —
 * `Bivariant`, because an author's def types each callback over its own value
 * and result, and the builder only ever hands those back.
 */
type ErasedStages<T> = Omit<ToolDef, "execute"> &
  ErasedGate & {
    readonly dialog?: AnyDialog | undefined;
    readonly require?:
      | Bivariant<[value: DeepReadonly<T>, args: Args], ToolFailure | undefined>
      | undefined;
  };

/** `SlotToolDef` as the builder reads it. */
export type ErasedSlotToolDef<T> = ErasedStages<T> & {
  readonly execute: Bivariant<[args: Args, value: DeepReadonly<T>, ctx: ToolContext], unknown>;
};

/** `SlotUpdateToolDef` and `SlotPreparedToolDef` as the builder reads them. */
export type ErasedUpdateToolDef<T> = ErasedStages<T> & {
  readonly report?: Bivariant<[stored: DeepReadonly<T>, partial: unknown], unknown> | undefined;
  readonly prepare?:
    | Bivariant<[args: Args, value: DeepReadonly<T>, ctx: ToolContext], unknown>
    | undefined;
  /** Three arguments without `prepare`, four with — `prepared` ahead of `ctx`. */
  readonly execute: Bivariant<[args: Args, draft: T, ...rest: unknown[]], unknown>;
};

/** The second-argument `sendFrom`, erased. */
export type SendOptions = ErasedSendOptions;

/**
 * The refusal an asynchronous mutation body earns, in one place.
 *
 * Both arms — the `async` DECLARATION and the sync function that RETURNS a
 * thenable — say the same thing and had drifted: one told the author to "call
 * the slot's update()", the other to call `${key}Slot.update`, inventing a
 * `Slot` suffix the key does not carry.
 *
 * @param how - What the caller did, appended to "must be synchronous".
 */
export function mustBeSync(key: string, how: string, method = "updateTool"): Error {
  return new Error(
    `The body of ${key}.${method} must be synchronous${how} — its mutations are committed when it returns, so an await inside it writes to a value that has already been stored. Do the awaiting in an ordinary tool() and call the slot's update() afterwards, or declare it as \`prepare\`.`,
  );
}

/** Refuse asynchronous mutations without leaving their eventual rejection unhandled. */
export function assertSynchronous(key: string, result: unknown, method: string): void {
  if (!isThenable(result)) return;
  void Promise.resolve(result).catch(() => undefined);
  throw mustBeSync(key, "", method);
}

/**
 * The gate a def declares, compiled — or nothing, for a tool with no `dialog`.
 * Declaring gate fields WITHOUT a dialog is refused: a `when` nothing checks
 * is the silent failure the gate exists to prevent.
 */
function gateOf<T>(
  key: string,
  def: ErasedStages<T>,
  options?: SendOptions,
): CompiledGate | undefined {
  if (def.dialog !== undefined) return compileDialogGate(def.dialog, def, options);
  const stray = ["when", "send", "sendFrom", "reset"].filter(
    (field) => def[field as keyof ErasedGate] !== undefined,
  );
  if (stray.length > 0 || options !== undefined) {
    throw new Error(
      `A tool on the "${key}" slot declares ${[...stray, ...(options ? ["a second-argument sendFrom"] : [])].join(", ")} but no \`dialog\` to gate on. Name the dialog, or drop the gate fields.`,
    );
  }
  return undefined;
}

/** The def with the stage fields taken off: what the runtime's `ToolDef` carries. */
function wireFields<T>(
  def: ErasedStages<T> & { execute: unknown; report?: unknown; prepare?: unknown },
): Omit<ToolDef, "execute"> {
  const {
    execute: _execute,
    dialog: _dialog,
    when: _when,
    send: _send,
    sendFrom: _sendFrom,
    reset: _reset,
    require: _require,
    report: _report,
    prepare: _prepare,
    ...wire
  } = def;
  return wire;
}

/**
 * A RETURNED failure, carried out of a mutation window as a throw.
 *
 * The gate's rule is that a failed tool did not do the thing, and the slot's
 * is that a mutator which threw stored nothing — so a body that mutated its
 * draft and then returned a {@link ToolFailure} must store nothing either, or
 * the model is told the tool failed while the slot (and the page) show it
 * succeeded. The window discards on a throw, so the failure is thrown through
 * it and caught right outside, where it becomes the tool's result again.
 * Private: nothing an author writes can meet it.
 */
class ReturnedFailure {
  readonly failure: ToolFailure;
  constructor(failure: ToolFailure) {
    this.failure = failure;
  }
}

/** Run `step` through a window; a returned failure thrown out of it is the result. */
function discardingOnFailure<R>(step: () => R, failed: (failure: ToolFailure) => R): R {
  try {
    return step();
  } catch (error) {
    if (error instanceof ReturnedFailure) return failed(error.failure);
    throw error;
  }
}

/** Throw a returned failure out of the window it was returned in; anything else passes. */
function refuseFailure<R>(result: R): R {
  if (isToolFailure(result)) throw new ReturnedFailure(result);
  return result;
}

/**
 * What a body hands the pipeline: its settled result, and the event the gate
 * decided from it — decided where the body ran, so that a mutating tool
 * decides INSIDE its window and a bad `sendFrom` field discards the draft.
 */
type Outcome = { readonly result: unknown; readonly event: GateEvent | undefined };

/** The gate's `decide`, or nothing to decide for an ungated tool. */
type Decide = (result: unknown) => GateEvent | undefined;

const undecided: Decide = () => undefined;

/**
 * A body as the pipeline runs it, in two forms: the SYNCHRONOUS one an
 * ungated, unprepared tool answers directly (so a sync body's declared `R` is
 * what the tool answers), and the one the async pipeline awaits, handed what
 * `prepare` produced and the gate's `decide`.
 */
type PipelineBody = {
  sync(args: Args, ctx: ToolContext): unknown;
  staged(
    args: Args,
    ctx: ToolContext,
    prepared: unknown[],
    decide: Decide,
  ): Outcome | Promise<Outcome>;
};

/**
 * The one pipeline both builders are a selection of stages from: the dialog
 * refusal, `require` on the frozen value, the async `prepare` with a second
 * `require` behind it, `body`, and the dialog's transition with its envelope.
 *
 * Synchronous when the def declares neither `prepare` nor `dialog`, which is
 * what keeps a plain tool's output type its body's own.
 */
function buildPipeline<T>(
  core: SlotCore<T>,
  def: ErasedStages<T> & { execute: unknown; report?: unknown; prepare?: unknown },
  options: SendOptions | undefined,
  body: PipelineBody,
): ToolDef {
  const gate = gateOf(core.key, def, options);
  const { require } = def;
  const prepare = def.prepare as ErasedUpdateToolDef<T>["prepare"];
  const wire = wireFields(def);
  if (gate === undefined && prepare === undefined) {
    return {
      ...wire,
      execute: (args, ctx) => require?.(core.get(ctx), args) ?? body.sync(args, ctx),
    };
  }
  return {
    ...wire,
    execute: async (args, ctx) => {
      const refused = gate?.refuse(ctx) ?? require?.(core.get(ctx), args);
      if (refused) return refused;
      let prepared: unknown[] = [];
      if (prepare !== undefined) {
        const value = await prepare(args, core.get(ctx), ctx);
        if (isToolFailure(value)) return value;
        // A step's tool calls run CONCURRENTLY, so the value `require` passed
        // may have changed during the await; the fresh one is what the window
        // is about to open on.
        const again = require?.(core.get(ctx), args);
        if (again) return again;
        prepared = [value];
      }
      // Every setup stage has passed: a `reset` is applied here, not before
      // `require`, so a tool refused by its own precondition does not restart
      // the conversation.
      gate?.enter(ctx);
      const { result, event } = await body.staged(args, ctx, prepared, gate?.decide ?? undecided);
      return gate === undefined ? result : gate.settle(ctx, result, event);
    },
  };
}

/**
 * `SessionSlot.tool`: the frozen value handed to the body, around which a
 * `require` and a `dialog` may run. Synchronous when ungated, so a sync body's
 * declared `R` is what the tool answers.
 */
export function buildSlotTool<T>(
  core: SlotCore<T>,
  def: ErasedSlotToolDef<T>,
  options?: SendOptions,
): ToolDef {
  const { execute } = def;
  return buildPipeline(core, def, options, {
    sync: (args, ctx) => execute(args, core.get(ctx), ctx),
    // No window to decide inside of: a read body is settled, then decided.
    staged: async (args, ctx, _prepared, decide) => {
      const result = await execute(args, core.get(ctx), ctx);
      return { result, event: decide(result) };
    },
  });
}

/**
 * `SessionSlot.updateTool`: the whole pipeline around the window, with
 * `report` on what it stored.
 */
export function buildUpdateTool<T>(
  core: SlotCore<T>,
  def: ErasedUpdateToolDef<T>,
  options?: SendOptions,
): ToolDef {
  const { key } = core;
  const { execute, report } = def;
  // At DECLARATION, where the overwhelming majority of this mistake is
  // visible. The check in the window still stands for a sync function that
  // RETURNS a promise, which only the call can see.
  if (execute.constructor?.name === "AsyncFunction") {
    throw mustBeSync(key, ", and this one is `async`");
  }

  /**
   * The window: the body on the draft, then — still inside it, on the value
   * about to be stored — `report` and the gate's decision. A failure RETURNED
   * by either, like a throw, stores nothing; so does a `sendFrom` field that
   * holds no event name, which `decide` refuses. A `report` that answers a
   * promise is settled after the window closed, so its failure cannot discard.
   */
  const commit = (
    args: Args,
    ctx: ToolContext,
    prepared: unknown[],
    decide: Decide,
  ): Outcome | Promise<Outcome> =>
    discardingOnFailure(
      () =>
        core.update(
          ctx,
          (draft) => {
            const out = execute(args, draft, ...prepared, ctx);
            // The half the declaration-time check cannot see. Its mutations
            // would be committed at the end of the synchronous part and it
            // would then mutate a frozen draft — a `TypeError` from somewhere
            // unrelated. Named here.
            assertSynchronous(key, out, "updateTool");
            return refuseFailure(out);
          },
          (stored, partial): Outcome | Promise<Outcome> => {
            const result = report === undefined ? partial : report(stored, partial);
            if (isThenable(result)) {
              return Promise.resolve(result).then((settled) => ({
                result: settled,
                event: decide(settled),
              }));
            }
            return { result: refuseFailure(result), event: decide(result) };
          },
        ),
      (failure) => ({ result: failure, event: undefined }),
    );
  return buildPipeline(core, def, options, {
    sync: (args, ctx) => {
      const outcome = commit(args, ctx, [], undecided);
      return isThenable(outcome) ? outcome.then((o) => o.result) : outcome.result;
    },
    staged: commit,
  });
}

/** `SessionSlot.transact`: `prepare` ahead of the window, from a plain tool. */
export async function transactSlot<T, Prep, R>(
  core: SlotCore<T>,
  ctx: SlotHolder,
  tx: SlotTransaction<T, Prep, R>,
): Promise<R | ToolFailure> {
  const refused = tx.require?.(core.get(ctx));
  if (refused) return refused;
  const prepared = await tx.prepare(core.get(ctx));
  if (isToolFailure(prepared)) return prepared;
  const again = tx.require?.(core.get(ctx));
  if (again) return again;
  // A `commit` that returned a failure stores nothing, like one that threw.
  return discardingOnFailure(
    () =>
      core.update(ctx, (draft) => {
        const result = tx.commit(draft, prepared);
        assertSynchronous(core.key, result, "transact");
        return refuseFailure(result);
      }),
    (failure) => failure,
  );
}
