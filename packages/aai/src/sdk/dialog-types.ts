// Copyright 2026 the AAI authors. MIT license.
/**
 * The authoring TYPES of `dialog()` — what a gated tool is handed, what it
 * answers with, and the two ways a dialog's shape can be declared.
 *
 * Split out of `sdk/dialog.ts` when that file crossed the 500-line cap, along
 * the seam an author already reads as one unit: `sdk/dialog.ts` is the FACTORY
 * (it owns a slot, starts actors and stops them), and this is the vocabulary a
 * `tools/` module names without ever calling it. Import them from
 * `@alexkroman1/aai` — `sdk/dialog.ts` re-exports every name here, so nothing
 * about where a dialog type comes from changed.
 *
 * @module dialog-types
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

/**
 * Where a dialog currently is.
 *
 * @public
 */
export interface DialogPosition {
  /**
   * The active state as a dotted path — `"verifying"`, or `"quote.pending"` for
   * a nested one. Parallel regions are joined with `","`.
   */
  readonly state: string;
  /** Whether the machine has reached a final state. */
  readonly done: boolean;
  /**
   * The active state's `meta.instruction`, when it declares one — what the
   * agent is supposed to be doing here, in the words the state itself carries.
   *
   * Read from the DEEPEST active state node, so a nested state's instruction
   * wins over its parent's rather than being merged with it.
   */
  readonly instruction?: string;
}

/**
 * What a {@link Dialog.tool} answers on success.
 *
 * @typeParam R - The author's own `execute` return type, under `result`.
 *
 * @public
 */
export interface DialogToolResult<R> extends DialogPosition {
  /** Whatever the tool's own `execute` returned. */
  readonly result: R;
}

/**
 * The authoring shape of a gated tool — {@link ToolDef} plus the two things
 * that make it part of a dialog: where it may run, and what it advances.
 *
 * @typeParam P - The tool's input schema.
 * @typeParam R - What `execute` returns.
 * @typeParam E - The machine's event union.
 *
 * @public
 */
export interface DialogToolDef<P extends ToolInputSchema, R, E> {
  /** See {@link ToolDef.description} — what the model reads to decide to call it. */
  description: string;
  /** See {@link ToolDef.inputSchema}. */
  inputSchema?: P;
  /**
   * The state(s) this tool may run in, as {@link DialogPosition.state} spells
   * them. Anywhere else the body does not run and the call is refused.
   *
   * Every name is checked against the machine's own states when the tool is
   * DECLARED, so a typo is a throw at startup rather than a tool that is
   * silently unreachable for the life of the agent.
   */
  when: string | readonly string[];
  /**
   * The event to send once `execute` has succeeded — how the conversation moves
   * on. Omit both this and `sendFrom` for a tool that reads without advancing.
   *
   * **Nothing is sent when `execute` returns a {@link ToolFailure}.** A tool
   * that failed did not do the thing, so a dialog that advanced anyway would
   * leave the conversation a step ahead of reality — the single most expensive
   * bug this primitive can have, since every later gate is then wrong too.
   */
  send?: E;
  /**
   * The event to send, decided by the RESULT — for a tool whose outcome picks
   * the transition. Return `undefined` to stay put.
   *
   * Separate from `send` rather than a union with it because a union of an
   * event and a function of one cannot be narrowed by `typeof`: an event type is
   * generic here, so TypeScript cannot rule out that it is itself callable, and
   * the check would need a cast to compile. Two fields are also the clearer
   * authoring surface — the static case stays a literal. Declaring both is an
   * error.
   *
   * **`NoInfer` is what makes the parameter mean anything.** `R` is inferred
   * from `execute`, and a bare `(result: R) => …` here puts `R` in a SECOND
   * inference position — so which one wins is decided by the object literal's
   * source order. A `sendFrom` written ABOVE `execute` inferred `R = unknown`
   * from its own parameter, and then compiled: the narrowing an author wrote it
   * for silently stopped meaning anything, with no error anywhere and no way to
   * tell the two orderings apart by reading either one. `NoInfer<R>` takes this
   * position out of the running, so `execute` decides `R` in both orderings and
   * a typo'd property is a `TS2551` in both.
   *
   * **`Exclude<…, ToolFailure>` is the other half, and it was already true at
   * run time**: the failure check returns before `sendFrom` is reached, so a
   * failure is never handed to it. Saying so in the type is what lets a body
   * declared `Order | ToolFailure` be narrowed here without the author
   * re-checking a case that cannot arrive.
   */
  sendFrom?: (result: Exclude<NoInfer<R>, ToolFailure>) => E | undefined;
  /**
   * The tool body. Runs only in one of `when`'s states.
   *
   * May be async: the result is AWAITED before the failure check and the
   * transition, so `sendFrom` and `result` both see the settled value. Unlike
   * {@link SessionSlot.updateTool} there is no synchronous requirement here —
   * this opens no mutation window around the body, only inside `send`.
   *
   * **`ToolFailure` is in the return type rather than in `R`**, which is what
   * lets `sendFrom` be typed over the SUCCESS value alone. A body that can fail
   * is the ordinary case — it is how a tool reports something the model should
   * recover from — and folding the failure into `R` made every `sendFrom`
   * narrow a value it is never handed: the failure check returns before it runs.
   */
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): R | ToolFailure | Promise<R | ToolFailure>;
}

/**
 * One state of a {@link DialogSpec} — the plain-object form of a dialog's shape.
 *
 * These are the six things every dialog in the templates actually used, and
 * they are not a subset chosen for convenience: a dialog's snapshot is
 * PERSISTED, so it must survive `structuredClone`, which rules out guards,
 * actions, context and invoked actors by construction. What was left was an
 * XState `setup({ types: {} as { events: … } })` block whose event union
 * restated every name already written in the `on` maps, and a
 * `meta: { instruction }` wrapper around every line of guidance.
 *
 * **The reason to type it is a SILENT failure, not the line count.** The
 * instruction is read back out of `meta` untyped (`_dialog-snapshot.ts`), and
 * XState types `meta` as `Record<string, any>` unless a machine declares
 * `types: {} as { meta: … }` — which no template did. So `instructions`
 * (plural), or the field one nesting level off, compiled, deployed, and
 * produced refusals carrying no recovery text at all: exactly the failure the
 * `when` gate exists to prevent, arriving through the field that is supposed to
 * explain it. A declared `instruction?: string` makes that a typo the compiler
 * catches.
 *
 * A dialog that needs anything beyond these six passes a machine instead — the
 * {@link dialog} overload taking one is not going away, and `procedure()` is
 * where full XState lives.
 *
 * @public
 */
export interface DialogStateSpec {
  /**
   * What the agent is supposed to be doing here, in this state's own words.
   * Becomes {@link DialogPosition.instruction} while the state is active, which
   * is what a refusal quotes and what every gated tool's result carries.
   */
  instruction?: string;
  /**
   * The transitions out of this state: event name to target state, exactly as
   * an XState `on` map spells it. Every key here joins the event union
   * {@link Dialog.send} and a gated tool's `send`/`sendFrom` accept, so an
   * event a spec never declares is a compile error rather than an event
   * silently ignored at run time.
   */
  on?: Record<string, string>;
  /** Whether reaching this state ENDS the dialog — XState's `type: "final"`. */
  final?: true;
  /** For a state with `states`: which child it starts in. */
  initial?: string;
  /** Nested states, addressed as `parent.child` by `when` and by `matches`. */
  states?: Record<string, DialogStateSpec>;
}

/**
 * A dialog's shape as a plain state map — the argument to the {@link dialog}
 * overload that takes no XState machine. See {@link DialogStateSpec}.
 *
 * @public
 */
export interface DialogSpec {
  /** Which state a fresh dialog starts in. */
  initial: string;
  /** The states, keyed by the name `when` and {@link DialogPosition.state} use. */
  states: Record<string, DialogStateSpec>;
}

/** Every event name a state's `on` map declares, and its descendants' too. */
type NamesIn<S> =
  | (S extends { on: infer O } ? Extract<keyof O, string> : never)
  | (S extends { states: infer M } ? NamesInMap<M> : never);

/**
 * Distributed over a `states` map's VALUES.
 *
 * Written as its own distributive conditional rather than inlined, because
 * `keyof` a UNION of `on` maps is the INTERSECTION of their keys — i.e. `never`
 * for any dialog with more than one state, which is a spec whose events all
 * type-check as nothing at all. Distributing first is what makes the union a
 * union.
 *
 * The recursion is bounded by {@link DialogStateSpec} declaring `states` as
 * OPTIONAL: `{ states?: … }` does not match `{ states: infer M }`, so walking
 * the bare constraint — which is what `dialog<const S extends DialogSpec>` makes
 * the compiler do while checking the overload — stops at the first level instead
 * of chasing a self-referential type forever. Making that property required
 * would reintroduce a `TS2589` on a declaration nobody has written yet.
 */
type NamesInMap<M> =
  M extends Record<string, unknown>
    ? M[keyof M] extends infer C
      ? C extends unknown
        ? NamesIn<C>
        : never
      : never
    : never;

/** One event object per name, so the union narrows by `type`. */
type EventOf<N> = N extends string ? { type: N } : never;

/**
 * The event union a {@link DialogSpec} declares — synthesized from its `on`
 * keys at every depth.
 *
 * This is what a spec-declared dialog gets INSTEAD of the `setup({ types: {} as
 * { events: … } })` block it replaces: the names are already written in the
 * `on` maps, so restating them is a second source of truth that can disagree
 * with the first. `dialog.send`, `send` and `sendFrom` are typed against it, so
 * a misspelled event is a compile error at the call site rather than an event
 * XState quietly ignores.
 *
 * @public
 */
export type DialogEvent<S extends DialogSpec> = EventOf<NamesInMap<S["states"]>>;
