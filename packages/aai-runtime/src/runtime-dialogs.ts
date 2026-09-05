// Copyright 2026 the AAI authors. MIT license.
/**
 * One session's declared dialogs, bound to the things a dialog cannot reach
 * from inside a tool call.
 *
 * `dialog()` gives an agent a statechart and a gate: a tool declared `when`
 * simply does not run outside those states. Everything else a dialog promises
 * happens when NO TOOL IS RUNNING, which is why declaring one in
 * `agent({ dialogs })` is what wires it up rather than a formality:
 *
 * 1. **Session events reach it.** A caller goes quiet, barges in, hangs up, or
 *    says something that calls no tool — none of those are tool calls, so
 *    without this bridge none of them could move a dialog and an author had to
 *    mirror the machine by hand in an `events` handler.
 * 2. **Its instruction reaches the MODEL every turn.** Until now the only way a
 *    phase reached the model was a tool RESULT, so on a turn where no tool ran
 *    the dialog was invisible — which is exactly the turn where the agent asks
 *    the question the phase had already moved past.
 * 3. **Its deadlines are armed.** A dialog holds no live actor (see
 *    `_dialog-events.ts`, "`after` cannot work here"), so the only thing that
 *    can run a per-state deadline is something outside it. This is that.
 * 4. **Its per-state voice knobs are applied** — the three of five that can be —
 *    see `runtime-dialog-knobs.ts`.
 *
 * ## The bridge runs BEFORE the agent's own `events` hooks
 *
 * The emitter's fixed order is record → send → **dialogs** → hooks → commit, and
 * the position of step three is the decision. A dialog is part of the session's
 * STATE; a hook is an observer of what the session did. By the time an observer
 * runs, everything the event caused should already have happened — so a
 * `"session.timed-out"` handler that reads `claim.position(ctx)` sees the state
 * the dialog moved TO, which is the state it declared a transition to precisely
 * in order to handle this event. The other order hands that handler the state
 * the call has just left, silently and with no way to tell from the handler.
 *
 * Nothing wants the other order: no part of the runtime reads a hook's result,
 * and a hook that drives a dialog by hand (`claim.receive(ctx, e)`, which is
 * supported and typed) is idempotent against this bridge — the machine has
 * already taken the transition, and offering the same event again finds nothing
 * that handles it.
 *
 * ## A dialog observes the SESSION, not its own transitions
 *
 * A transition WRITES a slot, a write needs a commit, and a commit emits
 * `state.updated` — which is a session event, which a dialog may declare a
 * transition on. Unguarded that is unbounded recursion with no symptom but a
 * blown stack mid-call. So the whole settle — the commit, the re-arm and the
 * prompt push — runs under a latch, and an event emitted while it is held is
 * recorded and sent to the client like any other and offered to no dialog. The
 * shape and the argument are the emitter's own `announcing` guard, one layer up.
 *
 * ## The clock runs from the dialog's last MOVE
 *
 * A deadline is armed when the dialog enters the state and re-armed every time
 * the dialog MOVES — including a self-transition, which is a move even though
 * the state path is unchanged. It is not extended by caller activity the dialog
 * did not declare an interest in.
 *
 * That is the reading that makes both of the shapes a voice call wants
 * expressible, without the runtime guessing which events count as "activity":
 *
 * - **A silence ladder** wants "since we last heard anything". Declare the
 *   hearing: `on: { "@user-transcript.committed": "listening" }` on the state
 *   itself is a self-transition, so every committed utterance re-arms the window
 *   and only real silence reaches the deadline.
 * - **An abandonment or escalation deadline** wants wall clock from entry —
 *   "still verifying after three minutes". Declare no transition on the chatter
 *   and the window is never extended by it.
 *
 * A runtime rule instead ("reset on any user speech") would have made the second
 * one unexpressible on any caller who talks, and would have given one written
 * declaration two meanings depending on which events happened to arrive. The
 * author names the events that count, which is the same thing `@`-prefixed
 * transitions already are.
 */

import type { AnyDialog, SlotHolder, SlotStore } from "@alexkroman1/aai";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import { createRestartableTimer, type RestartableTimer } from "./_timer.ts";
import type { Logger } from "./runtime-config.ts";
import { mergeTurnKnobs, reportDialogKnobs } from "./runtime-dialog-knobs.ts";
import type { SessionSystemPrompt } from "./runtime-system-prompt.ts";
import type { DialogTurnSource } from "./transports/pipeline-dialog-knobs.ts";
import type { Transport } from "./transports/types.ts";

/**
 * The section the active instructions become, ahead of the base prompt's own
 * sections.
 *
 * Labelled rather than appended bare, and worded like the base prompt's last
 * section (`buildSystemPrompt`'s "Agent-specific instructions (these override
 * the defaults above where they conflict)"): the suffix is one more section to
 * the model, so it should read as one — and an unlabelled sentence at the end of
 * a 10,000-character prompt reads as an afterthought rather than as the thing
 * the turn is about.
 */
const SUFFIX_HEADING =
  "Where this conversation is now (this is the step you are on, and it takes " +
  "precedence over the general instructions above where they conflict):";

/** One dialog's armed deadline: the state it belongs to, and what it sends. */
type ArmedDeadline = { readonly state: string; readonly event: { readonly type: string } };

/**
 * One declared dialog plus the two things this session holds for it.
 *
 * A record per dialog rather than three parallel arrays indexed together: the
 * arrays were the same length by construction and by nothing the compiler could
 * see, so every read of one had to be justified against the others — which is
 * exactly the bookkeeping a timer that fires the wrong dialog's event comes out
 * of.
 */
type BoundDialog = {
  readonly dialog: AnyDialog;
  readonly timer: RestartableTimer;
  /** The deadline currently running, or `undefined` when none is. */
  armed: ArmedDeadline | undefined;
};

/** What `createSession` holds for one session's dialogs. @internal */
export interface SessionDialogs {
  /**
   * This session's system prompt, with the dialog suffix installed.
   *
   * Handed back rather than taken as a dependency and mutated, because the
   * install is the whole point of the object: a caller that received a
   * `SessionSystemPrompt` from `SystemPromptResolver.forSession()` and then also
   * had to remember to pass it here would have a second, silent way to get a
   * session whose dialogs are invisible to the model.
   */
  readonly prompt: SessionSystemPrompt;
  /**
   * Offer one session event to every declared dialog. Called by the emitter,
   * after the client send and before the agent's own hooks.
   */
  observe(event: SessionEvent): void;
  /**
   * The per-turn voice knobs for the transport, or `undefined` when no declared
   * state carries one the pipeline can apply — see `runtime-dialog-knobs.ts`.
   */
  readonly turnKnobs: DialogTurnSource | undefined;
  /**
   * Disarm every deadline. Called when the session stops.
   *
   * A pending `setTimeout` keeps the event loop alive, so a deadline armed on a
   * state nobody is in any more holds the process open for the length of that
   * window past the end of the call — and then fires into a session whose slot
   * cache has been swept, which is the shape of a leak that only shows up under
   * load.
   */
  stop(): void;
}

/** The inert dialogs an agent that declares none gets. */
function noDialogs(prompt: SessionSystemPrompt): SessionDialogs {
  return {
    prompt,
    observe: () => undefined,
    turnKnobs: undefined,
    stop: () => undefined,
  };
}

/**
 * Bind an agent's declared dialogs to one session.
 *
 * **No suffix is installed when the agent declares no dialogs**, which is what
 * keeps the seam invisible to every agent shipping today: `SessionSystemPrompt`
 * hands back the base string ITSELF rather than a concatenation when nothing is
 * installed, so those sessions send byte-identical bytes to what they sent
 * before this module existed. A dialog whose active state declares no
 * `instruction` gets the same treatment one level down — the suffix renders
 * `""`, and `resolve()` short-circuits on an empty one.
 *
 * @internal
 */
export function openSessionDialogs(
  dialogs: readonly AnyDialog[] | undefined,
  sessionId: string,
  deps: {
    /** This session's prompt, fresh from `SystemPromptResolver.forSession()`. */
    prompt: SessionSystemPrompt;
    /** The same slot view a tool call's `ctx.slots` is. */
    slots: SlotStore;
    /**
     * This session's transport, resolved LATE.
     *
     * A thunk because the transport is built after this: it takes the prompt
     * thunk this module installs into, so the two cannot both be constructed
     * first. Only ever called from `settle`, which runs on a transition, which
     * cannot happen before the session is live.
     */
    transport: () => Transport | undefined;
    logger: Logger;
    /**
     * Push the `syncState` projection and flush the store — the same pair the
     * tool executor runs in its `finally`, and the same one the emitter runs for
     * a hook that wrote. Absent on the sandbox path, which holds no state in
     * this process; a transition then still moves the dialog and still reaches
     * the model, and what it loses is the durable write.
     */
    commit?: (() => void) | undefined;
  },
): SessionDialogs {
  const { prompt, transport, logger, commit } = deps;
  if (dialogs === undefined || dialogs.length === 0) return noDialogs(prompt);
  const list = dialogs;
  const live = reportDialogKnobs(list, logger);

  /**
   * The slot view, counting writes.
   *
   * The count is how this module knows a dialog MOVED: `Dialog.receive` writes
   * the slot when — and only when — the active state handled the event, and it
   * returns the position either way, so comparing positions cannot tell a
   * self-transition from a no-op. It is the same instrument
   * `session-emitter.ts` uses on a hook's context and for the same reason: the
   * commit is what a move costs, and the overwhelming majority of session events
   * reach a dialog that declares no transition on them.
   *
   * ONE view for the session rather than one per pass, because `claimKey`'s
   * ownership registry is keyed by the store object — a fresh view per event
   * would re-register the claim on every transcript frame.
   */
  let writes = 0;
  const watched: SlotStore = {
    read: (key) => deps.slots.read(key),
    write: (key, value, durable) => {
      deps.slots.write(key, value, durable);
      writes += 1;
    },
  };
  const ctx: SlotHolder = { slots: watched, sessionId };

  const bound: BoundDialog[] = list.map((dialog) => {
    const entry: BoundDialog = {
      dialog,
      timer: createRestartableTimer(() => onDeadline(entry)),
      armed: undefined,
    };
    return entry;
  });
  /** True while a transition and everything it owes are being settled. */
  let advancing = false;
  /** The suffix last pushed to the transport — see `settle`. */
  let pushed = "";
  let primed = false;

  /**
   * Run `what` for one dialog, containing a throw.
   *
   * Per dialog rather than per pass, so a machine that throws does not also stop
   * the dialog after it in the list from seeing the event — they are independent
   * declarations, exactly as the emitter's two hook slots are. And contained at
   * all because this runs from transport event dispatch on a live call: a throw
   * here has no call site to land in, and hanging up on a caller over a dialog
   * that mis-stepped is worse than the mis-step.
   */
  function guarded(dialog: AnyDialog, what: string, run: () => void): void {
    try {
      run();
    } catch (err: unknown) {
      logger.warn("Dialog step failed", {
        sessionId,
        dialog: dialog.key,
        step: what,
        error: errorMessage(err),
      });
    }
  }

  /** The instructions in force, in DECLARATION order — see `SUFFIX_HEADING`. */
  function renderSuffix(): string {
    const lines: string[] = [];
    for (const { dialog } of bound) {
      guarded(dialog, "position", () => {
        const at = dialog.position(ctx);
        // A state with nothing to say contributes NOTHING — not a blank line and
        // not a placeholder. Concatenated in declaration order because that is
        // the only order an author wrote down and can see; sorting by key would
        // be arbitrary, and a "last dialog wins" rule would silently drop the
        // instruction of every dialog but one, which is the opposite of what
        // declaring two of them asks for.
        if (at.instruction !== undefined) lines.push(at.instruction);
      });
    }
    return lines.length === 0 ? "" : `${SUFFIX_HEADING}\n${lines.join("\n")}`;
  }

  /**
   * (Re)arm one dialog's deadline from the state it is in NOW.
   *
   * The armed state path is recorded with it, and `onDeadline` compares: a
   * gated TOOL can move the dialog without this module ever being called, so a
   * timer that survives such a move would fire the event the state it was armed
   * for declared, into a conversation that has left it.
   */
  function rearm(entry: BoundDialog): void {
    guarded(entry.dialog, "timeout", () => {
      const declared = entry.dialog.timeout(ctx);
      if (declared === undefined) {
        entry.armed = undefined;
        entry.timer.clear();
        return;
      }
      entry.armed = { state: entry.dialog.position(ctx).state, event: declared.event };
      entry.timer.arm(declared.afterMs);
    });
  }

  /**
   * What a transition owes once it has happened: the write is committed, every
   * mover's deadline is re-armed, and a CHANGED prompt is pushed.
   *
   * The prompt push is conditional because `refreshSystemPrompt` reaches a
   * service: OpenAI Realtime holds its instructions as session state, so this is
   * a `session.update` frame and the VAD state behind it. Pipeline mode does not
   * implement the method at all — it assembles the prompt per request, so there
   * is nothing to push and the suffix thunk has already answered.
   */
  function settle(): void {
    commit?.();
    const next = renderSuffix();
    if (next === pushed) return;
    pushed = next;
    transport()?.refreshSystemPrompt?.();
  }

  /**
   * Materialize each dialog and arm its opening deadline.
   *
   * Deferred to the first session event rather than done when this is built,
   * because a RESUME hydrates the slot store inside `core.start()` — which runs
   * after `createSession` returns. Reading a dialog before that stores the
   * machine's fresh initial snapshot over a position the caller had already
   * reached, and the call resumes at the top of a script it was halfway through.
   * By the first event the hydrate has landed.
   */
  function prime(): void {
    if (primed) return;
    primed = true;
    for (const entry of bound) rearm(entry);
    pushed = renderSuffix();
  }

  /**
   * A deadline elapsed: send the event the state declared, and settle.
   *
   * The state is re-checked first. `armed` records what the window was opened
   * for, so a dialog a tool moved in the meantime re-arms from where it actually
   * is instead of firing a transition the conversation has already left — the
   * one move this module cannot observe, since a gated tool writes the slot
   * through the tool executor's own view.
   */
  function onDeadline(entry: BoundDialog): void {
    const deadline = entry.armed;
    if (deadline === undefined || advancing) return;
    advancing = true;
    try {
      if (entry.dialog.position(ctx).state !== deadline.state) return;
      logger.debug("Dialog deadline fired", {
        sessionId,
        dialog: entry.dialog.key,
        state: deadline.state,
        event: deadline.event.type,
      });
      guarded(entry.dialog, "send", () => entry.dialog.send(ctx, deadline.event));
      settle();
    } finally {
      advancing = false;
      // Outside the latch, so the re-armed deadline of a state a timeout moved
      // INTO is itself armed — a ladder whose every rung is a deadline is the
      // ordinary shape, and one that armed only its first rung would stall on
      // the second.
      rearm(entry);
    }
  }

  // THE install, and the reason this returns the prompt rather than taking one
  // and hoping. A thunk that renders fresh, so pipeline mode — which resolves at
  // each `startLlmStream` — is correct with no push at all, and `settle`'s push
  // is only what a service holding its instructions as session state needs.
  prompt.setSuffix(renderSuffix);

  return {
    prompt,
    observe(event: SessionEvent): void {
      // The re-entry guard: `state.updated` is a session event, `settle` emits
      // one through the commit, and a dialog may transition on it. See the
      // module doc.
      if (advancing) return;
      prime();
      advancing = true;
      try {
        let moved = false;
        for (const entry of bound) {
          const before = writes;
          guarded(entry.dialog, "receive", () => entry.dialog.receive(ctx, event));
          if (writes === before) continue;
          moved = true;
          rearm(entry);
        }
        if (moved) settle();
      } finally {
        advancing = false;
      }
    },
    // Built only when some state declares a knob the pipeline can apply, so an
    // agent whose dialogs carry instructions and deadlines alone leaves the
    // transport exactly as it was — including its preemptive generation, which
    // the transport turns off whenever this is present.
    turnKnobs: live ? () => mergeTurnKnobs(list, ctx) : undefined,
    stop(): void {
      for (const entry of bound) entry.timer.clear();
    },
  };
}
