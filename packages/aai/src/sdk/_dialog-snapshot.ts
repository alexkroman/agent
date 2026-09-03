// Copyright 2026 the AAI authors. MIT license.
/**
 * The pure half of `dialog()` — everything that reads an XState snapshot, or
 * builds a machine, without touching a session.
 *
 * Split out of `sdk/dialog.ts` when that file crossed the 500-line cap, and the
 * seam is the one it already had: these are total functions of a snapshot, of a
 * machine, or of a {@link DialogSpec}, where `dialog()` itself is the factory
 * that owns a slot, starts actors and stops them. That makes them the half a
 * reader can check by inspection — the dotted-path spelling, the
 * deepest-instruction rule, the state set a `when` is validated against, and the
 * machine a plain state map compiles to.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `dialog()` is the public surface.
 */

import {
  type AnyStateMachine,
  type AnyStateNodeConfig,
  createMachine,
  type Snapshot,
} from "xstate";
import type { DialogSpec, DialogStateSpec } from "./dialog-types.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";

/**
 * What a dialog stores per session: the actor's persisted snapshot, in a wrapper.
 *
 * The wrapper is not decoration. {@link SessionSlot.update} hands a mutator a
 * mutable DRAFT and stores whatever it leaves behind, so there is no way to
 * replace the slot's value wholesale from inside that window — and a snapshot is
 * exactly what has to be replaced, since it comes back from XState as a new
 * object. One field means the swap is `draft.snapshot = next`, inside the
 * synchronous window `update` guarantees, rather than a `set` racing a `get`.
 */
export type FlowState = { snapshot: Snapshot<unknown> };

/**
 * `snapshot.value` as the dotted path {@link DialogPosition.state} promises.
 *
 * XState reports a `StateValue`: a string for a leaf, and a nested object for a
 * compound or parallel state. One spelling is what `when` can be written
 * against, and it is the one `matches()` already accepts.
 */
export function toStatePath(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  return Object.entries(value)
    .map(([key, child]) => {
      const rest = toStatePath(child);
      return rest === "" ? key : `${key}.${rest}`;
    })
    .join(",");
}

/**
 * The active state's declared instruction, from the DEEPEST node that has one.
 *
 * `getMeta()` is keyed `"<machineId>.<statePath>"` for every ACTIVE node, parents
 * included, so a nested state's entry and its parent's both appear. The deepest
 * key is the longest one, which is the whole rule — a merge would have a parent's
 * general instruction override the specific one the caller is actually in.
 */
export function toInstruction(meta: Record<string, unknown>): string | undefined {
  let deepest = "";
  let instruction: string | undefined;
  for (const [key, value] of Object.entries(meta)) {
    if (!isRecord(value)) continue;
    const declared = value.instruction;
    if (typeof declared !== "string" || key.length < deepest.length) continue;
    deepest = key;
    instruction = declared;
  }
  return instruction;
}

/**
 * The stored value as XState will accept it, and the one seam where that is
 * asserted.
 *
 * It is the mirror of `session-slot.ts`'s own `frozen()` helper: the value
 * really is the snapshot this dialog wrote, and only the WRITE knows that — a
 * `DeepReadonly<T>` handed back by `get`, or the `unknown` a projection is
 * called with, cannot be narrowed to `Snapshot<unknown>` by inference. One
 * function rather than an assertion per call site, so there is one place to read
 * the argument.
 *
 * `undefined` for anything that is not the shape this module stores, which is
 * what makes a slot whose value predates this dialog (or was written by something
 * else) start the machine over rather than throw mid-call.
 */
export function readState(value: unknown): FlowState | undefined {
  if (!isRecord(value)) return undefined;
  const snapshot = value.snapshot;
  return isRecord(snapshot) ? { snapshot: snapshot as Snapshot<unknown> } : undefined;
}

/** Every state path a machine can be in, for validating `when` at declaration. */
export function statePaths(machine: AnyStateMachine): Set<string> {
  const paths = new Set<string>();
  const walk = (states: Record<string, { states?: Record<string, unknown> }>, prefix: string) => {
    for (const [key, node] of Object.entries(states)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      paths.add(path);
      // A nested node's own children are reachable as `parent.child`, and a
      // `when` may name either depth — `matches("quote")` is true while in
      // `quote.pending`, so both spellings have to be accepted.
      if (isRecord(node.states)) walk(node.states as Parameters<typeof walk>[0], path);
    }
  };
  walk(machine.states as Parameters<typeof walk>[0], "");
  return paths;
}

/** One state map as XState state-node configs. Recurses into nested `states`. */
function toNodes(states: Record<string, DialogStateSpec>): Record<string, AnyStateNodeConfig> {
  const nodes: Record<string, AnyStateNodeConfig> = {};
  for (const [name, state] of Object.entries(states)) {
    // `omitUndefined` rather than four conditional spreads: `exactOptionalPropertyTypes`
    // is on, and XState reads an explicitly-`undefined` `initial` or `states` as
    // a declaration of one (guard-invariants rule 2).
    nodes[name] = omitUndefined({
      type: state.final === true ? ("final" as const) : undefined,
      // The whole reason the spec form exists: `meta.instruction` is the field
      // `_dialog-snapshot.toInstruction` reads back, and XState types `meta` as
      // `Record<string, any>`, so a misspelling of it is silent in the machine
      // form and a compile error here. The wrapper is applied ONCE, here.
      meta: state.instruction === undefined ? undefined : { instruction: state.instruction },
      on: state.on,
      initial: state.initial,
      states: state.states === undefined ? undefined : toNodes(state.states),
    });
  }
  return nodes;
}

/**
 * The XState machine a {@link DialogSpec} describes.
 *
 * A real machine, not a parallel implementation: everything downstream —
 * `statePaths`, the actor, `getPersistedSnapshot`, `matches` — sees exactly what
 * it sees for a hand-written one, so the STORED SNAPSHOT FORMAT is identical and
 * a `durable: true` dialog resumes across an author's switch from one form to
 * the other. That is the property to protect if this ever grows a feature: the
 * spec is sugar over `createMachine`, never a second runtime.
 *
 * The machine's `id` is the dialog's key. XState only uses it to prefix
 * `getMeta()`'s keys and to resolve `#id.state` targets, and the key is the one
 * name a dialog already has.
 */
export function machineFromSpec(key: string, spec: DialogSpec): AnyStateMachine {
  return createMachine({ id: key, initial: spec.initial, states: toNodes(spec.states) });
}

/**
 * Refuse a call that never passed a spec — `dialog({ initial, states })`, the
 * one-object shape every other authoring function in this SDK takes.
 *
 * Deliberately NOT an assertion signature and deliberately not in `dialog()`
 * itself: narrowing `source` to a record at the call site collapses the
 * `AnyStateMachine | DialogSpec` union the `"transition" in source` test there
 * depends on. This only has to reject.
 */
export function assertDialogSource(source: unknown): void {
  if (isRecord(source)) return;
  throw new Error(
    "dialog(key, spec) takes the KEY first, before the spec — " +
      "that key is where this dialog's position is kept for a session, the way " +
      "`sessionSlot(key, …)` takes one: a dialog IS a slot with a machine over it.",
  );
}
