// Copyright 2026 the AAI authors. MIT license.
// Speaking-edge machinery for the pipeline transport: turning the STT
// transcript stream into the `speech_started` / `speech_stopped` the client
// sees. Two layers, deliberately separate —
//
//   createSpeechEdgeTracker  WHEN an utterance starts and ends (pipeline mode
//                            has no VAD, so this is derived from partials and
//                            finals, with a watchdog for utterances that never
//                            commit).
//   createGatedSpeechEdges   WHETHER the client is told, which depends on
//                            whether the agent currently holds the floor.
//
// The turn orchestration that consumes both lives in pipeline-user-speech.ts.

import { createActor, setup } from "xstate";
import { createRestartableTimer } from "../_timer.ts";
import type { TransportEventBody } from "./types.ts";

/**
 * Edge-detect "user is speaking" from the STT transcript stream: the first
 * partial/final of an utterance fires `onSpeechStarted`, and the utterance
 * committing (or resolving as a false interruption) fires `onSpeechStopped`.
 */
export interface SpeechEdgeTracker {
  /**
   * A non-empty partial or final arrived — open the speaking edge (the
   * `onSpeechStarted` emit is idempotent) and restart the idle watchdog.
   */
  speechStarted(): void;
  /** The utterance resolved (commit / false-alarm) — close the edge (idempotent). */
  speechEnded(): void;
  /**
   * How long the current utterance has been running (ms since the edge
   * opened), or 0 when the user is not speaking. Drives the
   * `interruptionMinDurationMs` barge-in gate.
   */
  durationMs(): number;
  /**
   * Forget the current edge without emitting (session reset / teardown).
   *
   * Propagates to the OUTWARD gate — see {@link GatedSpeechEdges.reset}. It has
   * to: dropping the edge here while the gate keeps a held one leaves the gate
   * holding an utterance nobody tracks, and a later `release` reports a
   * `speech_started` for it.
   */
  reset(): void;
}

/**
 * Create a {@link SpeechEdgeTracker} bound to the transport callbacks.
 *
 * `idleTimeoutMs` is a watchdog, not the primary close path: a genuine
 * utterance closes the edge when its final commits. But an STT partial
 * that never reaches a non-empty final (noise, a hallucinated interim) would
 * otherwise leave the edge open for the rest of the session — `speech_stopped`
 * never firing, and a stale `startedAtMs` making {@link durationMs} grow
 * without bound so the `interruptionMinDurationMs` gate always passes. The
 * watchdog restarts on every partial, so it only fires once the transcript
 * stream has actually gone quiet.
 *
 * That makes the watchdog the transport's one signal for "this utterance
 * produced no final and never will", which is why `onIdle` exists: it IS the
 * false-interruption recovery signal (see pipeline-recovery.ts), not merely
 * the release for a resume some other timer decided on. So `idleTimeoutMs` is
 * the resume deadline as well as the edge-leak bound, and 0 disables recovery
 * along with the watchdog. `onIdle` fires ONLY from the watchdog — never from
 * the commit path's `speechEnded()`, where a turn did commit and a resume must
 * not run.
 */
export function createSpeechEdgeTracker(
  callbacks: {
    onSpeechStarted(): void;
    onSpeechStopped(): void;
    /**
     * Forget any edge downstream too, emitting nothing. Optional so a test can
     * pass a bare pair of spies; {@link GatedSpeechEdges} supplies it, which is
     * what the transport actually wires here.
     */
    reset?(): void;
  },
  opts: {
    idleTimeoutMs: number;
    /** The open edge went quiet without committing a turn. */
    onIdle?: (() => void) | undefined;
  },
): SpeechEdgeTracker {
  let speaking = false;
  let startedAtMs = 0;
  const idleWatchdog = createRestartableTimer(() => {
    if (!speaking) return;
    endSpeech();
    opts.onIdle?.();
  });

  function endSpeech(): void {
    idleWatchdog.clear();
    if (!speaking) return;
    speaking = false;
    callbacks.onSpeechStopped();
  }

  return {
    speechStarted(): void {
      // Restart the watchdog on every partial, including ones that don't open
      // the edge — quiet, not "no longer the first partial", is what ends it.
      idleWatchdog.arm(opts.idleTimeoutMs);
      if (speaking) return;
      speaking = true;
      startedAtMs = Date.now();
      callbacks.onSpeechStarted();
    },
    speechEnded: endSpeech,
    durationMs(): number {
      return speaking ? Date.now() - startedAtMs : 0;
    },
    reset(): void {
      idleWatchdog.clear();
      speaking = false;
      callbacks.reset?.();
    },
  };
}

/**
 * Gate on the OUTWARD speaking edges so `speech_started` means the same thing
 * in pipeline mode as it does in S2S: the user took the floor and the agent is
 * yielding to them.
 *
 * In S2S the service emits its speech-started the moment it decides to stop
 * generating, so the event coincides with a real interruption. Pipeline mode
 * has no VAD and derives the edge from the STT transcript stream, where the
 * first non-empty partial fires it — one word of a cough, a backchannel, or a
 * phrase the caller addressed to someone else in the room. The barge-in gates
 * (`minBargeInWords`, `interruptionMinDurationMs`) correctly decline to abort
 * the reply for those, so the agent keeps talking; the client was told it
 * stopped.
 *
 * That divergence is not cosmetic. A client cannot distinguish the two
 * meanings, and the natural reading — the one the S2S transport taught it — is
 * "stop the agent": tau2-bench's harness DISCARDS its whole agent playout
 * buffer on `speech_started` and has no `cancelled` handler at all, so a reply
 * the agent was still speaking is thrown away and the caller hears the agent
 * fall silent for the rest of the turn. Measured on the benchmark's own
 * recorded audio, the agent yielded to non-directed speech on 12 of 12
 * occasions and stayed silent a median 5.9s afterwards, which is scored as a
 * selectivity failure and reads to the caller as an agent that quits mid-
 * sentence whenever they clear their throat.
 *
 * So while the agent holds the floor the edge is held back and released only
 * when a barge-in really fires (alongside `cancelled`), or when the agent
 * stops speaking on its own. While the agent is silent the edge passes
 * straight through — there is no floor to yield and the event is just
 * "listening". Live captions are unaffected either way:
 * `user_transcript_partial` is emitted independently of this gate.
 */
export interface GatedSpeechEdges {
  onSpeechStarted(): void;
  onSpeechStopped(): void;
  /**
   * Release a held edge — a barge-in was decided, or the agent went quiet.
   * No-op when nothing is held.
   */
  release(): void;
  /**
   * Forget the current edge without emitting, for a session reset.
   *
   * The mirror of {@link SpeechEdgeTracker.reset}, and it has to exist for the
   * same reason that one does: the tracker drops an open edge silently, so
   * without this the gate keeps a `held` edge belonging to an utterance nobody
   * is tracking any more — which a later {@link release} would then emit a
   * `speech_started` for. The two halves describe ONE edge and cannot be reset
   * independently.
   */
  reset(): void;
}

/** Events the gate accepts. The names are the machine's, not the wire's. */
type GateEvent =
  | { type: "SPEECH_STARTED" }
  | { type: "SPEECH_STOPPED" }
  | { type: "RELEASE" }
  | { type: "RESET" };

type GateInput = {
  report: (event: TransportEventBody) => void;
  agentIsSpeaking: () => boolean;
};

/**
 * The gate's three positions, as a statechart.
 *
 * This was a pair of booleans — `held` ("an edge the client has not been told
 * about") and `emitted` ("one it has") — which is four combinations for three
 * positions, and the fourth was reachable: `onSpeechStarted` while already
 * `emitted` set `held` on top of it, so a following {@link
 * GatedSpeechEdges.release} reported a SECOND `speech_started` with no
 * `speech_stopped` between them. Unpaired edges are the one thing this gate
 * exists to prevent, and the pair of flags could not say so. Here `emitted`
 * simply does not handle `SPEECH_STARTED`, so the client has been told once and
 * is told again only after a stop.
 *
 * The wire emits are the state's ENTRY and EXIT rather than statements inside a
 * setter, which is what makes that true: `speech_started` cannot be reported
 * without arriving in `emitted`, and `speech_stopped` cannot be reported
 * without leaving it.
 */
const gatedSpeechEdgesMachine = setup({
  types: {} as { context: GateInput; input: GateInput; events: GateEvent },
  guards: {
    /** The agent is talking, so the edge waits rather than telling the client. */
    agentHoldsFloor: ({ context }) => context.agentIsSpeaking(),
  },
  actions: {
    reportStarted: ({ context }) => context.report({ type: "speech.started" }),
    reportStopped: ({ context }) => context.report({ type: "speech.stopped" }),
  },
}).createMachine({
  id: "gatedSpeechEdges",
  context: ({ input }) => input,
  initial: "silent",
  // A reset is legal from anywhere and emits nothing — see
  // {@link GatedSpeechEdges.reset}. Root-level, because "forget where we are"
  // is not a fact about any one position.
  on: { RESET: ".silent" },
  states: {
    /** No edge: the client believes the user is not speaking, and is right. */
    silent: {
      on: {
        SPEECH_STARTED: [{ guard: "agentHoldsFloor", target: "held" }, { target: "emitted" }],
      },
    },
    /**
     * An edge the client has NOT been told about, because the agent had the
     * floor when it opened.
     *
     * `SPEECH_STARTED` here is the tracker re-reporting an utterance that is
     * already open (`reset()` having dropped its speaking flag): it re-asks the
     * guard, so an agent that has since gone quiet releases the edge instead of
     * holding it for a `release` that may never come.
     */
    held: {
      on: {
        SPEECH_STARTED: [{ guard: "agentHoldsFloor" }, { target: "emitted" }],
        SPEECH_STOPPED: "silent",
        RELEASE: "emitted",
      },
    },
    /** The client has been told. Only leaving here may report the stop. */
    emitted: {
      entry: "reportStarted",
      on: { SPEECH_STOPPED: { target: "silent", actions: "reportStopped" } },
    },
  },
});

export function createGatedSpeechEdges(deps: {
  /**
   * The transport's report path. The OUTWARD edge, so it speaks the wire
   * vocabulary; the tracker-to-gate direction above keeps its two method names,
   * because that pair is this module's own interface rather than the session's.
   */
  report: (event: TransportEventBody) => void;
  agentIsSpeaking: () => boolean;
}): GatedSpeechEdges {
  // Long-lived and never persisted: the gate's position is per CONNECTION, and
  // a reconnect builds a new transport. So this is `createActor(...).start()`
  // once, not the read-snapshot-write-snapshot shape `sdk/dialog.ts` needs for a
  // position that has to survive the process.
  const actor = createActor(gatedSpeechEdgesMachine, { input: deps }).start();
  return {
    onSpeechStarted: () => actor.send({ type: "SPEECH_STARTED" }),
    onSpeechStopped: () => actor.send({ type: "SPEECH_STOPPED" }),
    release: () => actor.send({ type: "RELEASE" }),
    reset: () => actor.send({ type: "RESET" }),
  };
}
