// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything that can move a dialog other than a tool call: a SESSION EVENT,
 * and TIME.
 *
 * A dialog could only be advanced by something the model did — a
 * {@link Dialog.tool} that ran, or a hand-written {@link Dialog.send}. That is
 * the whole vocabulary a form-filling flow needs and about half of what a voice
 * CALL is made of: the caller goes quiet, barges in, hangs up, says something
 * that calls no tool at all, or lets the session time out. None of those are
 * tool calls, so none of them could move a dialog, and an author who wanted to
 * react to one had to mirror the machine by hand in an `events` handler.
 *
 * ## The `@` namespace, and why it is a namespace
 *
 * A session event reaches a dialog as an ordinary XState event named for the
 * wire type under a leading `@` — `on: { "@session.timed-out": "abandoned" }`.
 * The prefix is what keeps the two vocabularies apart: an author's own events
 * are SCREAMING_CASE by convention but nothing enforces that, and a dialog that
 * happened to declare `on: { "reply.completed": … }` for its own purposes would
 * otherwise start firing on every reply the agent made. Under `@` the two sets
 * cannot collide, and a reader can tell at a glance which transitions the
 * runtime drives and which the agent does.
 *
 * The names are VALIDATED against the real {@link SessionEventType} union at
 * declaration ({@link assertDialogSessionEvents}), for the same reason a
 * `when` naming no state is: `@sesion.timed-out` is an event XState would
 * accept, store and never match, so the state that was supposed to catch a
 * dead call would simply never be entered — with nothing at run time to say so.
 *
 * ## `after` cannot work here, and used to look like it did
 *
 * XState's delayed transitions are timers owned by a RUNNING actor, and a
 * dialog's actor is created, sent to, persisted and stopped inside one
 * synchronous window (see `actorFor` in `sdk/dialog.ts`) — there is no actor
 * alive to fire one. So `after` in a dialog is a transition that can never
 * happen, and every check in this package used to pass it: `_dialog-graph.ts`
 * reads the transitions XState desugars `after` INTO, so a state whose only
 * exit was a delay counted as having a way out, and the graph guard's own test
 * fixture used exactly that shape as a PASSING case. An author got a green
 * startup check for a dialog that would sit in that state for the rest of the
 * call.
 *
 * Both forms are refused now, and the refusal names {@link DialogStateSpec.timeout}
 * — a declared deadline the runtime arms and disarms around the actor's
 * lifetime, rather than a timer inside it.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `dialog()` is the public surface.
 */

import type { AnyStateMachine } from "xstate";
import { declaredTimeout } from "./_dialog-meta.ts";
import type { DialogSpec, DialogStateSpec } from "./dialog-types.ts";
import { isRecord } from "./is-record.ts";
import { SESSION_EVENT_TYPES } from "./protocol-events.ts";

/**
 * The character that makes a dialog event a SESSION event.
 *
 * One constant rather than a `"@"` at four call sites, because the prefix is
 * the contract: it is what {@link Dialog.receive} prepends, what the validator
 * strips, and what {@link DialogEvent} subtracts from the union an author may
 * send by hand.
 */
export const SESSION_EVENT_PREFIX = "@";

/** The event name a session event of `type` arrives as. See the module doc. */
export function toDialogEventType(type: string): string {
  return `${SESSION_EVENT_PREFIX}${type}`;
}

/** Every state node under a machine's root, and the root itself. */
function allNodes(machine: AnyStateMachine): readonly AnyStateMachine["root"][] {
  const out: AnyStateMachine["root"][] = [machine.root];
  const walk = (node: AnyStateMachine["root"]): void => {
    for (const child of Object.values(node.states)) {
      out.push(child);
      walk(child);
    }
  };
  walk(machine.root);
  return out;
}

/** The dotted path `statePaths`, `when` and `DialogPosition.state` all use. */
const pathOf = (node: AnyStateMachine["root"]): string => node.path.join(".");

/**
 * Refuse a transition on an `@` name that is not a session event.
 *
 * Read off the COMPILED machine rather than off a {@link DialogSpec}, so the
 * rule covers both `dialog()` overloads with one walk: XState resolves a state
 * node's `on` map into `transitions`, keyed by the event descriptor, whichever
 * form the machine came from.
 *
 * The message lists every legal name. That is long — sixteen of them — and it
 * is what the `when` refusal one level up already does with the state list, for
 * the same reason: the fix is always a name, and the author is looking at a
 * typo they cannot see.
 */
export function assertDialogSessionEvents(key: string, machine: AnyStateMachine): void {
  for (const node of allNodes(machine)) {
    for (const descriptor of node.transitions.keys()) {
      if (!descriptor.startsWith(SESSION_EVENT_PREFIX)) continue;
      const type = descriptor.slice(SESSION_EVENT_PREFIX.length);
      if (SESSION_EVENT_TYPES.has(type)) continue;
      throw new Error(
        `Dialog "${key}" transitions on "${descriptor}" in state "${pathOf(node)}", which is not a session event. An "@" name is a wire event type — the runtime sends it, so a name it never sends can never fire. The session events are: ${[...SESSION_EVENT_TYPES].sort().map(toDialogEventType).join(", ")}.`,
      );
    }
  }
}

/** The XState event descriptor a delayed (`after`) transition desugars into. */
const DELAYED_PREFIX = "xstate.after.";

/**
 * Refuse a machine that leaves a state on a DELAY. See the module doc.
 *
 * The machine form only: a {@link DialogSpec} has no `after` to desugar, so its
 * copy of this rule is {@link assertNoSpecDelays}, which has to read the spec
 * itself.
 */
export function assertNoDelayedTransitions(key: string, machine: AnyStateMachine): void {
  for (const node of allNodes(machine)) {
    for (const descriptor of node.transitions.keys()) {
      if (!descriptor.startsWith(DELAYED_PREFIX)) continue;
      throw new Error(
        `Dialog "${key}" uses \`after\` in state "${pathOf(node)}", and a dialog can never fire it: its actor is created, sent to, persisted and stopped inside one synchronous window, so no timer of the machine's ever runs. Declare \`timeout: { afterMs, send }\` on the state instead — the runtime arms that deadline outside the actor — or use \`procedure()\`, whose actor stays alive for the length of the call it runs in.`,
      );
    }
  }
}

/**
 * Refuse a {@link DialogSpec} state declaring `after`.
 *
 * Separate from the machine walk because the spec form DROPS it: `toNodes`
 * copies the six fields it knows and nothing else, so an `after` here reaches
 * no machine and would be invisible to every later check — the state would
 * simply have no way out, and the graph guard would report it as wedged with a
 * message about a missing event rather than about the delay the author wrote.
 *
 * Reached before the machine is built, so this message is the one an author
 * gets. `in` rather than a property read: `after` is deliberately not a field of
 * {@link DialogStateSpec} — a state map that declares one has already left the
 * shape this form describes.
 */
export function assertNoSpecDelays(key: string, spec: DialogSpec): void {
  const walk = (states: Record<string, DialogStateSpec>, prefix: string): void => {
    for (const [name, state] of Object.entries(states)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if ("after" in state) {
        throw new Error(
          `Dialog "${key}" declares \`after\` on state "${path}", which a dialog can never fire: its actor lives for one synchronous window, so no timer of the machine's ever runs. Use \`timeout: { afterMs, send }\` on that state instead — the runtime arms that deadline outside the actor and sends the event you name.`,
        );
      }
      if (state.states !== undefined) walk(state.states, path);
    }
  };
  walk(spec.states, "");
}

/**
 * Whether an event named `send` can be handled where `node` is active.
 *
 * Self-and-ancestors, not the node alone: being in a state is being in all of
 * them, so a leaf's deadline may legitimately be caught by the `on` map its
 * parent declares — the shape `emergency-dispatch-agent` uses, and the one the graph
 * guard's `hasExit` already had to learn. Refusing it would make this check a
 * source of false alarms on dialogs that work.
 */
function handles(node: AnyStateMachine["root"], send: string): boolean {
  for (let at: AnyStateMachine["root"] | undefined = node; at !== undefined; at = at.parent) {
    if (at.transitions.has(send)) return true;
  }
  return false;
}

/**
 * Refuse a `timeout` whose `send` names an event nothing there can handle.
 *
 * The same defect as a `when` naming no state, arriving through the field that
 * is supposed to rescue a stalled call: the deadline fires, the event is
 * ignored (XState ignores an unhandled event, which is the behaviour a live call
 * depends on), and the dialog sits exactly where it was — a caller who has said
 * nothing for two minutes stays in a state whose whole purpose was to give up.
 *
 * Read off the compiled machine so it covers a hand-written `meta.timeout` as
 * well as a spec's `timeout`, through {@link declaredTimeout} — the same
 * validator the reader uses, so the two cannot disagree about which states have
 * a deadline at all.
 */
export function assertDialogTimeouts(key: string, machine: AnyStateMachine): void {
  for (const node of allNodes(machine)) {
    const meta: unknown = node.meta;
    if (!isRecord(meta)) continue;
    const timeout = declaredTimeout(meta);
    if (timeout === undefined || handles(node, timeout.send)) continue;
    throw new Error(
      `Dialog "${key}" gives state "${pathOf(node)}" a timeout sending "${timeout.send}", which neither it nor any state containing it declares in its \`on\` map. The deadline would fire and be ignored, leaving the dialog exactly where it was — add \`on: { ${timeout.send}: "<state>" }\`, or send an event that state already handles.`,
    );
  }
}
