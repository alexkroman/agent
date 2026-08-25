// Copyright 2026 the AAI authors. MIT license.
/**
 * A dialog's shape read as a GRAPH: which states can be entered, and which can
 * be left.
 *
 * `dialog()` already refused one graph defect — an `initial` naming no state —
 * and the sentence it refused with is the whole argument for this module:
 * "Nothing would ever transition out of it." That is true of any state with no
 * way out, and it was checked for exactly one node.
 *
 * XState catches the third defect in this family and nothing catches the other
 * two. Measured against 5.32:
 *
 * | defect | `createMachine` |
 * | --- | --- |
 * | `on: { GO: "nope" }`, no such state | THROWS, eagerly |
 * | a state nothing targets | accepted |
 * | a non-final state with no way out | accepted, `status` stays `active` |
 *
 * Both silent ones are product bugs rather than style, because a dialog state
 * is not just a position — it carries the `instruction` a gated tool quotes
 * when it refuses. An unreachable state's instruction is guidance the model can
 * never be given. A wedged state's is guidance the caller can never act out of:
 * `DialogPosition.done` is `false` forever, so every `when`-gated tool goes on
 * refusing with the same line for the rest of the call.
 *
 * ## Edges come from XState, never from the spec
 *
 * A target is resolved against the node that OWNS the transition — bare names
 * are siblings, a leading `.` is a descendant, `#id` is absolute — and a
 * parent's `on` applies to every descendant. Re-deriving those rules here would
 * be a second, worse copy of them. So the walk reads
 * {@link https://stately.ai/docs/state-nodes | StateNode} objects that XState
 * has already resolved: `transitions` (which `after`, `onDone` and `onError`
 * are desugared into) plus `always`, whose `target` is an array of state nodes
 * rather than strings.
 *
 * That is also what makes the check safe on the `dialog(key, machine)` overload
 * rather than only on a {@link DialogSpec}: a machine using `always` or an
 * invoked actor's `onDone` to leave a state is read correctly, where a check
 * that only knew about `on` would report it as wedged.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `dialog()` is the public surface.
 */

import type { AnyStateMachine } from "xstate";

/**
 * One resolved state node.
 *
 * Derived from `AnyStateMachine` rather than written as `StateNode<any, any>`,
 * which would be an `as any` in a type position with the same effect: the
 * machine's own root is already this type, so the alias costs nothing and there
 * is no cast in this module.
 */
type DialogNode = AnyStateMachine["root"];

/**
 * Every state node a transition on `node` can land in.
 *
 * `always` is read separately because XState keeps eventless transitions off
 * the `transitions` map — verified against 5.32, where a node whose only exit
 * is `always` reports an empty `transitions`. Reading one and not the other is
 * the shape of bug this whole module exists to catch, one level up.
 */
function targetsOf(node: DialogNode): readonly DialogNode[] {
  const out: DialogNode[] = [];
  for (const definitions of node.transitions.values()) {
    for (const transition of definitions) {
      if (transition.target) out.push(...transition.target);
    }
  }
  for (const transition of node.always ?? []) {
    if (transition.target) out.push(...transition.target);
  }
  return out;
}

/**
 * `node` and every state containing it, outermost last.
 *
 * Being in a state is being in all of them, so this is the set whose
 * transitions are takeable — the half a per-state check misses. It is how
 * `dispatch-center`'s `working.triaging` leaves through `working`'s own `on`.
 */
function selfAndAncestors(node: DialogNode): readonly DialogNode[] {
  const chain: DialogNode[] = [];
  for (let at: DialogNode | undefined = node; at !== undefined; at = at.parent) chain.push(at);
  return chain;
}

/**
 * The states entering `node` puts the machine in as well: a compound node's
 * `initial` child, or every region of a parallel one. Nobody targets these, so
 * a reachability walk that only followed transitions would miss them.
 */
function alsoEntered(node: DialogNode): readonly DialogNode[] {
  if (node.type === "compound") return node.initial.target;
  if (node.type === "parallel") return Object.values(node.states);
  return [];
}

/** Whether anything can move the machine out of `node`. */
function hasExit(node: DialogNode): boolean {
  return selfAndAncestors(node).some((at) => targetsOf(at).length > 0);
}

/**
 * Every state node the machine can actually be in, from a fresh start.
 *
 * "Reachable" is not the same question as "targeted by some transition" — see
 * {@link alsoEntered} — which is why a node reachable only as somebody's
 * initial child is not reported.
 *
 * The recursion terminates on the `seen` guard rather than on depth: every node
 * expands once, and a cycle — which is what a healthy dialog IS — re-enters a
 * node already in the set and returns.
 */
function reachableFrom(root: DialogNode): ReadonlySet<DialogNode> {
  const seen = new Set<DialogNode>();
  const enter = (node: DialogNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of alsoEntered(node)) enter(child);
    for (const at of selfAndAncestors(node)) {
      for (const target of targetsOf(at)) enter(target);
    }
  };
  enter(root);
  return seen;
}

/** Every state node under `root`, root itself excluded — it is the machine. */
function allNodes(root: DialogNode): readonly DialogNode[] {
  const out: DialogNode[] = [];
  const walk = (node: DialogNode): void => {
    for (const child of Object.values(node.states)) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** The dotted path `statePaths`, `when` and `DialogPosition.state` all use. */
const pathOf = (node: DialogNode): string => node.path.join(".");

/**
 * Refuse a machine whose `initial` names no state it declares.
 *
 * XState resolves it to a state that does not exist, so every `position()`
 * reads as that name and no event ever transitions — a dialog silently stuck
 * before the first turn. It is the same check `Dialog.tool({ when })` already
 * makes over the state it gates on, one level up. It moved here from
 * `_dialog-snapshot.ts` when the other two graph rules were written, because
 * all three answer the same question and one of them should not be able to
 * pass while another is skipped.
 */
function assertInitialState(
  key: string,
  machine: AnyStateMachine,
  valid: ReadonlySet<string>,
): void {
  const initial = String(machine.config.initial);
  if (valid.has(initial)) return;
  throw new Error(
    `Dialog "${key}" starts in "${initial}", which is not one of its states (${[...valid].sort().join(", ")}). Nothing would ever transition out of it.`,
  );
}

/**
 * Refuse a dialog whose graph has a state the conversation can never reach, or
 * one it can never leave.
 *
 * Thrown at declaration — `dialog()` runs at module load — so a defect surfaces
 * when the agent bundle is built rather than in the one call that happens to
 * reach the state. Both messages name the states, because the fix is always
 * either an edge that is missing or a state that is.
 *
 * @param key - The dialog's key, so the message names which dialog.
 * @param machine - The compiled machine, spec-built or hand-written.
 * @param valid - `statePaths(machine)`, already computed by the caller for
 *   `when` validation; passed rather than recomputed so the two cannot disagree
 *   about what a state is called.
 */
export function assertDialogGraph(
  key: string,
  machine: AnyStateMachine,
  valid: ReadonlySet<string>,
): void {
  assertInitialState(key, machine, valid);

  const nodes = allNodes(machine.root);
  const reachable = reachableFrom(machine.root);

  const orphans = nodes.filter((node) => !reachable.has(node)).map(pathOf);
  if (orphans.length > 0) {
    throw new Error(
      `Dialog "${key}" can never reach ${orphans.sort().join(", ")} — nothing transitions there, and it is not where the dialog starts. A state the dialog cannot enter is an instruction the model can never be given: give it an incoming event, or delete it.`,
    );
  }

  // A machine that declares no transition ANYWHERE is out of scope, and this is
  // a boundary rather than an exemption. The defect below is "the author drew a
  // graph with a hole in it", and a dialog with no edges has drawn no graph —
  // it is a `sessionSlot` holding a constant. Nothing ever moved, so nothing
  // got stuck, and the message's remedy ("give it an outgoing event") would be
  // advice to write a different feature. The rule is therefore conditional: IF
  // the dialog can move at all, every place it can come to rest must have a way
  // onward.
  //
  // `atomic` is the whole test for "a place it can come to rest": `final` is its
  // own node type, and a compound or parallel node is never the resting
  // position — its leaves are.
  const moves = nodes.some((node) => targetsOf(node).length > 0);
  const wedged = moves
    ? nodes.filter((node) => node.type === "atomic" && !hasExit(node)).map(pathOf)
    : [];
  if (wedged.length > 0) {
    throw new Error(
      `Dialog "${key}" can never leave ${wedged.sort().join(", ")} — the state declares no transition, and neither does any state containing it. The dialog would stay there for the rest of the call, refusing every gated tool with the same instruction: give it an outgoing event, or mark it \`final: true\` if arriving there is the end.`,
    );
  }
}
