// Copyright 2026 the AAI authors. MIT license.
/**
 * The pure half of `flow()` — everything that reads an XState snapshot without
 * touching a session.
 *
 * Split out of `sdk/flow.ts` when that file crossed the 500-line cap, and the
 * seam is the one it already had: these are total functions of a snapshot (or of
 * a machine), where `flow()` itself is the factory that owns a slot, starts
 * actors and stops them. That makes them the half a reader can check by
 * inspection — the dotted-path spelling, the deepest-instruction rule, and the
 * state set a `when` is validated against.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `flow()` is the public surface.
 */

import type { AnyStateMachine, Snapshot } from "xstate";
import { isRecord } from "./is-record.ts";

/**
 * What a flow stores per session: the actor's persisted snapshot, in a wrapper.
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
 * `snapshot.value` as the dotted path {@link FlowPosition.state} promises.
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
 * really is the snapshot this flow wrote, and only the WRITE knows that — a
 * `DeepReadonly<T>` handed back by `get`, or the `unknown` a projection is
 * called with, cannot be narrowed to `Snapshot<unknown>` by inference. One
 * function rather than an assertion per call site, so there is one place to read
 * the argument.
 *
 * `undefined` for anything that is not the shape this module stores, which is
 * what makes a slot whose value predates this flow (or was written by something
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

/**
 * One state node's declared `meta.instruction`, walking a DOTTED PATH.
 *
 * The snapshot version above reads `getMeta()`, which only a live actor sitting
 * in the state can produce. A DERIVED flow has no actor — its position is a
 * function of the data — so the instruction has to come off the machine's own
 * definition instead, and the two must agree on the rule: **the deepest node
 * that declares one wins.** Here that is a walk down the path keeping the last
 * instruction seen, which is the same answer `toInstruction`'s longest-key rule
 * gives for the same active path.
 *
 * `undefined` when no node on the path declares one, and when the path does not
 * exist — a caller that cares about the second asks {@link statePaths}.
 */
export function instructionAt(machine: AnyStateMachine, path: string): string | undefined {
  let states: Record<string, StateNodeShape> | undefined = machine.states as Record<
    string,
    StateNodeShape
  >;
  let instruction: string | undefined;
  for (const segment of path.split(".")) {
    const node: StateNodeShape | undefined = states?.[segment];
    if (node === undefined) return instruction;
    const declared = isRecord(node.meta) ? node.meta.instruction : undefined;
    if (typeof declared === "string") instruction = declared;
    states = node.states;
  }
  return instruction;
}

/** The shape this module needs off a state node, which XState types as `any`. */
type StateNodeShape = {
  meta?: unknown;
  type?: unknown;
  states?: Record<string, StateNodeShape>;
};

/**
 * EVERY state path declared `type: "final"`, at any depth.
 *
 * All depths rather than the top level, because a nested final is legal XState
 * and means something DIFFERENT: a final child of a compound state completes
 * that REGION — it is what `onDone` fires on — while the machine itself is done
 * only when its ROOT reaches a final state. Collecting both is what lets a
 * caller tell those apart; collecting only the top level would make the
 * distinction unrepresentable and the caller's root check dead code.
 *
 * So a caller answering "is the machine done" asks about the path's FIRST
 * segment, and one answering "is this region complete" asks about the whole
 * path. {@link DerivedFlow.position} does the first.
 */
export function finalPaths(machine: AnyStateMachine): Set<string> {
  const paths = new Set<string>();
  const walk = (states: Record<string, StateNodeShape>, prefix: string) => {
    for (const [key, node] of Object.entries(states)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (node.type === "final") paths.add(path);
      if (isRecord(node.states)) walk(node.states as Record<string, StateNodeShape>, path);
    }
  };
  walk(machine.states as Record<string, StateNodeShape>, "");
  return paths;
}
