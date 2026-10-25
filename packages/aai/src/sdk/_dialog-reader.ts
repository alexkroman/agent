// Copyright 2026 the AAI authors. MIT license.
/**
 * One actor per gated call: the position and the `matches` test off ONE
 * snapshot, registered by `dialog()` for `_dialog-gate.ts` to read.
 *
 * The gate used to ask the handle `matches(ctx, state)` once per allowed state
 * and `position(ctx)` once more, and each of those starts and stops an XState
 * actor over the stored snapshot — N + 1 actors to answer one question about
 * one state. A reader answers both off one actor. It is a side table rather
 * than a member of the public `Dialog` handle, so the contracted surface does
 * not grow a member only the gate calls; a handle nothing registered (one a
 * spec built by hand) falls back to the public members.
 *
 * Copy-local module state, and that is correct here: a dialog and the gate
 * compiled on it live in the same bundle (`dialog.tool` is a method of the
 * handle; a slot tool names the dialog it gates on).
 *
 * @module _dialog-reader
 */

import type { AnyDialog } from "./dialog-handle.ts";
import type { DialogPosition } from "./dialog-types.ts";
import type { SlotHolder } from "./session-state.ts";

/** Where a session's conversation is, and whether that is one of some states. */
export type DialogReading = {
  readonly position: DialogPosition;
  matches(state: string): boolean;
};

/** A reader as `dialog()` registers it: one snapshot read, both answers off it. */
export type DialogReader = (ctx: SlotHolder) => DialogReading;

const readers = new WeakMap<AnyDialog, DialogReader>();

/** Register `dialog`'s one-actor reader. */
export function registerDialogReader(dialog: AnyDialog, read: DialogReader): void {
  readers.set(dialog, read);
}

/** Read `dialog`'s position for this session, through its reader when it has one. */
export function readDialog(dialog: AnyDialog, ctx: SlotHolder): DialogReading {
  const read = readers.get(dialog);
  if (read !== undefined) return read(ctx);
  return { position: dialog.position(ctx), matches: (state) => dialog.matches(ctx, state) };
}
