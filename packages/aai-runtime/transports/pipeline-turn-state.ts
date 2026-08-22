// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn lifecycle state for the pipeline transport, as an explicit machine.
 *
 * This state used to live as loose mutable closure variables in
 * pipeline-transport.ts (`turnController`, `turnSpoke`, `ttsAudioOpen`), each
 * with its own comment explaining when it may change and in what order — an
 * arrangement where any new write site could silently break an invariant.
 * Here the discriminated {@link TurnPhase} makes "an abortable reply exists"
 * one fact instead of a nullable controller, and the named transitions below
 * are the only mutation path; the transport and its sibling policy modules
 * (pipeline-user-speech.ts et al) read through the queries.
 *
 * Two flags deliberately outlive the running phase, matching the transport's
 * long-standing semantics:
 *
 * - `spoke` — whether the current/most recent turn put audio on the wire.
 *   Cleared on {@link TurnMachine.begin} and {@link TurnMachine.interrupt},
 *   NOT on {@link TurnMachine.settle}: barge-in policy only consults it
 *   while a turn is in flight, and clearing at settle would be a second
 *   write site for no reader.
 * - `audioGateOpen` — whether TTS provider audio may reach the client.
 *   Closed on interrupt so chunks still in flight can't re-advance the
 *   playback clock or reach the just-flushed client; reopened by the next
 *   turn's first TTS text, which always precedes that turn's audio.
 *
 * Two further facts about the turn in flight — whether its body is done and
 * only the TTS drain remains, and whether it is a false-interruption resume —
 * lived on in `pipeline-transport.ts` as loose `let`s after this module was
 * written, which is the arrangement it exists to replace: each had one write
 * site, one comment saying so, and nothing enforcing it, while every reader
 * reached them through a predicate that also consulted {@link
 * TurnMachine.inFlight}. They are {@link TurnMachine.draining} and {@link
 * TurnMachine.resumeInFlight} now, so "what is true of the turn in flight" is
 * answered in one place.
 *
 * ## Why the four facts are PARALLEL REGIONS
 *
 * Naming the transitions was most of the win, and it left the last part
 * undone: the phase was a discriminated union, and `spoke`, `audioGateOpen`,
 * `draining` and `resumeScope` were four free booleans beside it. Two of those
 * are only meaningful WHILE a turn runs, and nothing said so —
 * `draining() && !inFlight()` was representable, and `resumeInFlight()` had to
 * spell the conjunction by hand ("both halves, because a resume scope with no
 * turn in it is not a resume in flight"). As four parallel regions, `draining`
 * is a SUBSTATE of `running`, so the first is unrepresentable and the second is
 * a query across two regions rather than a rule a reader has to be told.
 *
 * It also fixes a reset by omission: `begin` cleared `spoke` and left
 * `draining` alone, which was safe only because `runReply` pairs
 * `setDraining(false)` in a `finally`. Entering `running` now starts at its
 * initial `body` substate, so a new turn cannot inherit the previous one's
 * drain whatever the caller does.
 *
 * The one thing that stays OUTSIDE the machine is the `abort()` itself, and
 * `abortCurrent` below says why.
 */

import { assign, createActor, setup } from "xstate";

/** Everything that happens to a turn. */
type TurnEvent =
  | { type: "BEGIN"; ctl: AbortController }
  | { type: "SETTLE"; ctl: AbortController }
  /** Kill the turn in flight. The `abort()` itself is the wrapper's. */
  | { type: "ABORT" }
  /** Barge-in / cancel / reset — reaches three regions at once. */
  | { type: "INTERRUPT" }
  | { type: "MARK_SPOKE" }
  | { type: "OPEN_GATE" }
  | { type: "DRAIN_START" }
  | { type: "DRAIN_END" }
  | { type: "RESUME_SCOPE_ENTER" }
  | { type: "RESUME_SCOPE_EXIT" };

export interface TurnMachine {
  /** True while a turn is in flight server-side (an abortable reply exists). */
  inFlight(): boolean;
  /** True once the current/most recent turn has put audio on the wire. */
  spoke(): boolean;
  /** May TTS provider audio be forwarded to the client right now? */
  audioGateOpen(): boolean;
  /**
   * True while the in-flight turn's body has completed — its full text is
   * persisted with no `[interrupted]` marker — and only its TTS drain remains.
   *
   * The classifier for a barge-in in that window: the turn is still "in
   * flight" (the drain lasts as long as the remaining synthesis for a
   * sentence-flushing adapter), but resuming it from the marker would tell the
   * model to continue past an ending it already produced. See
   * `armBargeInRecovery` in pipeline-user-speech.ts.
   */
  draining(): boolean;
  /**
   * True while the turn in flight is a false-interruption resume — a committed
   * user turn moots one that has not spoken yet (`onSttFinal`).
   */
  resumeInFlight(): boolean;

  /** A new turn starts: it becomes the abortable reply; `spoke` resets. */
  begin(ctl: AbortController): void;
  /**
   * A turn's scaffold unwinds: return to idle — unless a newer turn already
   * replaced this one, which must stay in flight (the identity check that a
   * nullable-controller `if (turnController === ctl)` used to spell).
   */
  settle(ctl: AbortController): void;
  /** Abort the in-flight turn, if any, and return to idle. */
  abortCurrent(): void;
  /**
   * Barge-in / cancel / reset: abort the in-flight turn AND close the audio
   * gate and clear `spoke` — this runs even with no turn in flight (a
   * playback-tail barge-in interrupts audio whose turn already settled).
   */
  interrupt(): void;
  /** The current turn's audio reached the wire. */
  markSpoke(): void;
  /** New TTS text opens (or reopens) the audio gate for its turn. */
  openAudioGate(): void;
  /**
   * The turn's body finished and its TTS drain is starting (`true`), or the
   * drain is over (`false`). Paired around the drain in `runReply`.
   */
  setDraining(draining: boolean): void;
  /**
   * The chained turn about to run is (or is no longer) a false-interruption
   * resume. Paired around `runTurn` in `runChainedTurn`.
   */
  setResumeScope(resume: boolean): void;
}

/**
 * The four facts, as four parallel regions.
 *
 * `turn` is the only one with a substate, and that is the point: `draining`
 * lives INSIDE `running`, so a drain with no turn behind it cannot be
 * described. `gate` and `voice` are genuinely independent of it — the gate
 * closes on a barge-in whose turn already settled, and `spoke` outlives the
 * turn it describes (see {@link TurnMachine.spoke}) — which is why they are
 * siblings rather than substates.
 */
const turnStateMachine = setup({
  types: {} as { context: { ctl: AbortController | null }; events: TurnEvent },
  guards: {
    /**
     * Is this settle the CURRENT turn's? The identity check a nullable
     * `if (turnController === ctl)` used to spell, so a turn whose scaffold
     * unwinds after a replacement began cannot retire the replacement.
     */
    settlesCurrent: ({ context, event }) => event.type === "SETTLE" && context.ctl === event.ctl,
  },
  actions: {
    holdController: assign({
      ctl: ({ context, event }) => (event.type === "BEGIN" ? event.ctl : context.ctl),
    }),
    releaseController: assign({ ctl: null }),
  },
}).createMachine({
  id: "turnState",
  type: "parallel",
  context: { ctl: null },
  states: {
    /** Whether a turn is in flight, and how far through it is. */
    turn: {
      initial: "idle",
      states: {
        idle: { on: { BEGIN: { target: "running", actions: "holdController" } } },
        running: {
          initial: "body",
          on: {
            // `reenter`, so a turn that replaces another starts at `body`
            // rather than inheriting its drain.
            BEGIN: { target: "running", reenter: true, actions: "holdController" },
            SETTLE: {
              guard: "settlesCurrent",
              target: "idle",
              actions: "releaseController",
            },
            ABORT: { target: "idle", actions: "releaseController" },
            INTERRUPT: { target: "idle", actions: "releaseController" },
          },
          states: {
            /** The reply is still being produced. */
            body: { on: { DRAIN_START: "draining" } },
            /** The body is persisted; only the TTS drain remains. */
            draining: { on: { DRAIN_END: "body" } },
          },
        },
      },
    },
    /** Whether TTS provider audio may reach the client. Starts OPEN: the
     *  greeting's audio has to pass before any turn text has been sent. */
    gate: {
      initial: "open",
      states: {
        open: { on: { INTERRUPT: "closed" } },
        closed: { on: { OPEN_GATE: "open" } },
      },
    },
    /** Whether the current/most recent turn put audio on the wire. */
    voice: {
      initial: "unspoken",
      states: {
        unspoken: { on: { MARK_SPOKE: "spoken" } },
        // Cleared by a new turn and by an interrupt, NOT by a settle — see
        // {@link TurnMachine.spoke}.
        spoken: { on: { BEGIN: "unspoken", INTERRUPT: "unspoken" } },
      },
    },
    /**
     * Whether the chained call in progress is a false-interruption resume.
     *
     * Set around the whole chained call, so it brackets the moment before
     * `BEGIN` and the moment after `SETTLE` — which is why
     * {@link TurnMachine.resumeInFlight} reads this region AND `turn`.
     */
    resume: {
      initial: "outside",
      states: {
        outside: { on: { RESUME_SCOPE_ENTER: "inside" } },
        inside: { on: { RESUME_SCOPE_EXIT: "outside" } },
      },
    },
  },
});

/** Create a {@link TurnMachine}; the gate starts open for the greeting. */
export function createTurnMachine(): TurnMachine {
  const actor = createActor(turnStateMachine).start();
  const inFlight = (): boolean => actor.getSnapshot().matches({ turn: "running" });

  function abortCurrent(): void {
    const snapshot = actor.getSnapshot();
    if (!snapshot.matches({ turn: "running" })) return;
    // The abort runs HERE rather than as a machine action, and the ordering is
    // why: abort listeners fire synchronously and may consult `inFlight()`,
    // which must still describe the turn being killed. An action would have to
    // rely on XState committing the next snapshot only after actions run —
    // true today, and not a contract this module should rest an invariant on.
    snapshot.context.ctl?.abort();
    actor.send({ type: "ABORT" });
  }

  return {
    inFlight,
    spoke: () => actor.getSnapshot().matches({ voice: "spoken" }),
    audioGateOpen: () => actor.getSnapshot().matches({ gate: "open" }),
    // Unrepresentable outside `running` now: `draining` is its substate.
    draining: () => actor.getSnapshot().matches({ turn: { running: "draining" } }),
    resumeInFlight: () => {
      const snapshot = actor.getSnapshot();
      return snapshot.matches({ resume: "inside" }) && snapshot.matches({ turn: "running" });
    },
    begin: (ctl: AbortController) => actor.send({ type: "BEGIN", ctl }),
    settle: (ctl: AbortController) => actor.send({ type: "SETTLE", ctl }),
    abortCurrent,
    interrupt(): void {
      // Same ordering rule as `abortCurrent`, and this one runs even with no
      // turn in flight — a playback-tail barge-in still closes the gate and
      // clears `spoke`.
      const snapshot = actor.getSnapshot();
      if (snapshot.matches({ turn: "running" })) snapshot.context.ctl?.abort();
      actor.send({ type: "INTERRUPT" });
    },
    markSpoke: () => actor.send({ type: "MARK_SPOKE" }),
    openAudioGate: () => actor.send({ type: "OPEN_GATE" }),
    setDraining: (draining: boolean) =>
      actor.send({ type: draining ? "DRAIN_START" : "DRAIN_END" }),
    setResumeScope: (resume: boolean) =>
      actor.send({ type: resume ? "RESUME_SCOPE_ENTER" : "RESUME_SCOPE_EXIT" }),
  };
}
