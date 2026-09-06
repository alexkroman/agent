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
 * What an author DECLARES is the line this module draws. {@link Dialog} — the
 * handle `dialog()` hands BACK — is `sdk/dialog-handle.ts`, split off when this
 * file reached the 500-line cap in turn; every name from both is re-exported by
 * `sdk/dialog.ts` and by `@alexkroman1/aai`, so the split is invisible to an
 * import.
 *
 * @module dialog-types
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { SessionEventType } from "./session-events.ts";
import type { ToolChoice } from "./tool-def.ts";
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
 * A session event as a dialog names it: the wire type under a leading `@`.
 *
 * `"@session.timed-out"`, `"@speech.started"`, `"@user-transcript.committed"` —
 * every {@link SessionEventType} is one of these, and nothing else is. The
 * prefix is a NAMESPACE rather than decoration: an author's own event names are
 * unconstrained, so a dialog that declared `on: { "reply.completed": … }` for
 * its own purposes would otherwise start firing on every reply the agent made.
 *
 * Declaring one is what lets a dialog move on something the model did not do —
 * the caller went quiet, barged in, hung up, or said something that called no
 * tool. The runtime sends them through {@link Dialog.receive}, which is wired up
 * by listing the dialog in {@link AgentDef.dialogs}.
 *
 * @public
 */
export type DialogSessionEventName = `@${SessionEventType}`;

/**
 * A per-state deadline: how long the dialog may stay here, and what to send
 * when it has been that long. See {@link DialogStateSpec.timeout}.
 *
 * @public
 */
export interface DialogTimeoutSpec {
  /** How long the dialog may remain in this state, in milliseconds. */
  afterMs: number;
  /**
   * The event to send when it has been. Must name an event this state's own
   * `on` map declares — or one declared by a state containing it, since being
   * in a state is being in all of them — and that is checked when the dialog is
   * DECLARED: a deadline sending an event nothing handles fires into silence
   * and leaves the conversation exactly where it was.
   */
  send: string;
}

/**
 * A deadline as {@link Dialog.timeout} reports it: how long, and the event to
 * send.
 *
 * The event is built for the caller rather than left as a name, so a runtime
 * arming this deadline hands the result straight back to {@link Dialog.send}
 * and never has to know how `timeout.send` is spelled.
 *
 * @public
 */
export interface DialogTimeout {
  /** {@link DialogTimeoutSpec.afterMs}, from the state in force. */
  readonly afterMs: number;
  /** The event to send when the deadline passes. */
  readonly event: { readonly type: string };
}

/**
 * How interruptible the agent is while a dialog state is active.
 *
 * `"default"` leaves the agent's own `minBargeInWords` /
 * `interruptionMinDurationMs` in place; `"off"` means the agent finishes what it
 * is saying, which is what a disclosure or a legally-required read needs; the
 * object form tightens or loosens the same two gates for this phase only — a
 * menu wants `{ minWords: 1 }` so a caller can cut in on the first word.
 *
 * @public
 */
export type DialogBargeIn =
  | "default"
  | "off"
  | {
      /** Words in an interim transcript before a barge-in counts. */
      minWords?: number;
      /** Sustained speech before an interim-triggered barge-in counts, in ms. */
      minDurationMs?: number;
    };

/**
 * The per-state voice settings a dialog declares — what {@link Dialog.voiceConfig}
 * answers with, from the deepest active state that declares any of them.
 *
 * Every field is plain JSON, which is a requirement rather than a coincidence:
 * these ride in the state node's `meta`, and a dialog's snapshot is persisted
 * through `structuredClone` for a `durable` session.
 *
 * @public
 */
export interface DialogVoiceConfig {
  /** The TTS voice for this phase of the call. */
  readonly voice?: string;
  /** How interruptible the agent is here. See {@link DialogBargeIn}. */
  readonly bargeIn?: DialogBargeIn;
  /** STT biasing for what the caller is about to say here. */
  readonly keyterms?: readonly string[];
  /** The model's tool-choice policy while this state is active. */
  readonly toolChoice?: ToolChoice;
  /** The model's sampling temperature while this state is active. */
  readonly temperature?: number;
}

/**
 * One state of a {@link DialogSpec} — the plain-object form of a dialog's shape.
 *
 * It began as the six things every dialog in the templates actually used, and
 * they were not a subset chosen for convenience: a dialog's snapshot is
 * PERSISTED, so it must survive `structuredClone`, which rules out guards,
 * actions, context and invoked actors by construction. What was left was an
 * XState `setup({ types: {} as { events: … } })` block whose event union
 * restated every name already written in the `on` maps, and a
 * `meta: { instruction }` wrapper around every line of guidance.
 *
 * The six became eleven when a dialog had to be able to describe a CALL rather
 * than a form: a deadline (`timeout`) and the five per-phase voice knobs
 * (`voice`, `bargeIn`, `keyterms`, `toolChoice`, `temperature`). Every one of
 * them is plain JSON and rides in the same `meta` the instruction does, so the
 * constraint above is untouched and a `durable: true` dialog written before any
 * of this resumes byte-identically — a state declaring none of them compiles to
 * a node with no `meta` at all.
 *
 * **What is deliberately NOT here is `after`.** XState's delayed transitions are
 * timers owned by a running actor, and a dialog's actor is created, sent to,
 * persisted and stopped inside one synchronous window, so a dialog can never
 * fire one. Declaring it throws at declaration and the message names `timeout`,
 * which is the deadline a runtime can actually arm.
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
   *
   * A key starting with `@` is a SESSION event instead — see
   * {@link DialogSessionEventName}. Those are validated against the wire
   * vocabulary at declaration and are deliberately kept OUT of the union above:
   * an author does not send `@speech.started` by hand, the runtime does.
   */
  on?: Record<string, string>;
  /**
   * How long the dialog may stay in this state, and what to send when it has
   * been that long. See {@link DialogTimeoutSpec}.
   *
   * The declarative half of a deadline: nothing here starts a timer, because a
   * dialog holds no live actor to run one. The runtime reads it through
   * {@link Dialog.timeout} for the state the conversation is actually in and
   * arms it around the turn — which is why `send` has to name an event this
   * state (or one containing it) already handles, checked at declaration.
   */
  timeout?: DialogTimeoutSpec;
  /**
   * The TTS voice for this phase of the call — a different voice for the
   * disclosure than for the chat, say. See {@link DialogVoiceConfig}.
   */
  voice?: string;
  /**
   * How interruptible the agent is here. A disclosure state may need to FINISH;
   * a menu state wants to be maximally interruptible. See {@link DialogBargeIn}.
   */
  bargeIn?: DialogBargeIn;
  /**
   * STT biasing for what the caller is about to say in this state — the policy
   * number they are reading out, the product names on the menu.
   */
  keyterms?: readonly string[];
  /** The model's tool-choice policy while this state is active. */
  toolChoice?: ToolChoice;
  /** The model's sampling temperature while this state is active. */
  temperature?: number;
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
 * **The `@` names are SUBTRACTED**, which is the one thing this union does that
 * the `on` maps do not say by themselves. A session-event transition is driven
 * by the runtime — nobody writes `dialog.send(ctx, { type: "@speech.started" })`
 * — so leaving those names in would put a dozen events an author must never
 * send by hand into the autocomplete for the one they must. See
 * {@link DialogSessionEventName}; {@link Dialog.receive} is how they arrive.
 *
 * @public
 */
export type DialogEvent<S extends DialogSpec> = EventOf<
  Exclude<NamesInMap<S["states"]>, `@${string}`>
>;
