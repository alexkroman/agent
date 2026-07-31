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
 */

/** The turn phase: either no turn exists, or exactly one abortable reply. */
export type TurnPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly ctl: AbortController };

const IDLE: TurnPhase = { kind: "idle" };

export interface TurnMachine {
  /** True while a turn is in flight server-side (an abortable reply exists). */
  inFlight(): boolean;
  /** True once the current/most recent turn has put audio on the wire. */
  spoke(): boolean;
  /** May TTS provider audio be forwarded to the client right now? */
  audioGateOpen(): boolean;

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
}

/** Create a {@link TurnMachine}; the gate starts open for the greeting. */
export function createTurnMachine(): TurnMachine {
  let phase: TurnPhase = IDLE;
  let spoke = false;
  let audioGateOpen = true;

  function abortCurrent(): void {
    if (phase.kind !== "running") return;
    // Abort while still "running": abort listeners fire synchronously and
    // may consult inFlight(), which must describe the turn being killed.
    phase.ctl.abort();
    phase = IDLE;
  }

  return {
    inFlight: () => phase.kind === "running",
    spoke: () => spoke,
    audioGateOpen: () => audioGateOpen,
    begin(ctl: AbortController): void {
      phase = { kind: "running", ctl };
      spoke = false;
    },
    settle(ctl: AbortController): void {
      if (phase.kind === "running" && phase.ctl === ctl) phase = IDLE;
    },
    abortCurrent,
    interrupt(): void {
      abortCurrent();
      audioGateOpen = false;
      spoke = false;
    },
    markSpoke(): void {
      spoke = true;
    },
    openAudioGate(): void {
      audioGateOpen = true;
    },
  };
}
