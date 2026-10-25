// Copyright 2026 the AAI authors. MIT license.
/**
 * The tool builders behind `SessionSlot.tool`, `SessionSlot.updateTool` and
 * `SessionSlot.transact` — the one pipeline every slot-backed tool is a
 * selection of stages from.
 *
 * In order: the dialog refusal (`dialog`), `require` on the frozen value, the
 * async `prepare` with a second `require` behind it, the synchronous window
 * (the body, then the slot's `after` and `caps`), `report` on the value
 * actually stored, and the dialog's transition with its envelope. Each stage
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
} from "./_dialog-gate.ts";
import type { DeepReadonly } from "./deep-readonly.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import { isRecord } from "./is-record.ts";
import type { SlotTransaction } from "./session-slot-types.ts";
import type { SlotHolder } from "./session-state.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure, type ToolFailure } from "./utils.ts";

/** What the builders need of a slot: its key, a frozen read, and the window. */
export type SlotCore<T> = {
  readonly key: string;
  get(ctx: SlotHolder): DeepReadonly<T>;
  update<R>(ctx: SlotHolder, mutate: (draft: T) => R): R;
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

/** Would `await` on this do anything? */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

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
 * `SessionSlot.tool`: the frozen value handed to the body, around which a
 * `require` and a `dialog` may run. Synchronous when ungated, so a sync body's
 * declared `R` is what the tool answers.
 */
export function buildSlotTool<T>(
  core: SlotCore<T>,
  def: ErasedSlotToolDef<T>,
  options?: SendOptions,
): ToolDef {
  const gate = gateOf(core.key, def, options);
  const { execute, require } = def;
  const wire = wireFields(def);
  if (gate === undefined) {
    return {
      ...wire,
      execute: (args, ctx) => require?.(core.get(ctx), args) ?? execute(args, core.get(ctx), ctx),
    };
  }
  return {
    ...wire,
    execute: async (args, ctx) => {
      const refused = gate.refuse(ctx) ?? require?.(core.get(ctx), args);
      if (refused) return refused;
      return gate.settle(ctx, await execute(args, core.get(ctx), ctx));
    },
  };
}

/**
 * `SessionSlot.updateTool`: the whole pipeline. Synchronous when it declares
 * neither `prepare` nor `dialog`, which is what keeps a plain mutating tool's
 * output type its body's own.
 */
export function buildUpdateTool<T>(
  core: SlotCore<T>,
  def: ErasedUpdateToolDef<T>,
  options?: SendOptions,
): ToolDef {
  const { key } = core;
  const { execute, require, report, prepare } = def;
  // At DECLARATION, where the overwhelming majority of this mistake is
  // visible. The check in the window still stands for a sync function that
  // RETURNS a promise, which only the call can see.
  if (execute.constructor?.name === "AsyncFunction") {
    throw mustBeSync(key, ", and this one is `async`");
  }
  const gate = gateOf(key, def, options);
  const wire = wireFields(def);

  /** The window, then `report` on what it stored. */
  const commit = (args: Args, ctx: ToolContext, prepared: unknown[]): unknown => {
    const result = core.update(ctx, (draft) => {
      const out = execute(args, draft, ...prepared, ctx);
      // The half the declaration-time check cannot see. Its mutations would be
      // committed at the end of the synchronous part and it would then mutate a
      // frozen draft — a `TypeError` from somewhere unrelated. Named here.
      assertSynchronous(key, out, "updateTool");
      return out;
    });
    // A failure has no partial result to complete, and is answered unchanged
    // so the gate's "nothing sent on a failure" reads the same value.
    if (report === undefined || isToolFailure(result)) return result;
    return report(core.get(ctx), result);
  };

  if (gate === undefined && prepare === undefined) {
    return {
      ...wire,
      execute: (args, ctx) => require?.(core.get(ctx), args) ?? commit(args, ctx, []),
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
      const result = commit(args, ctx, prepared);
      return gate === undefined ? result : gate.settle(ctx, result);
    },
  };
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
  return core.update(ctx, (draft) => {
    const result = tx.commit(draft, prepared);
    assertSynchronous(core.key, result, "transact");
    return result;
  });
}
