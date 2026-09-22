// Copyright 2026 the AAI authors. MIT license.
/**
 * The client-facing VERBS of the pipeline transport — the object
 * `createPipelineTransport` returns.
 *
 * Split out of `pipeline-transport.ts` at the source-length cap, on the seam
 * that file's own shape suggests: everything above the split builds a session's
 * collaborators once, and this is the surface a session core calls INTO
 * afterwards. Nothing here owns state; each method routes one command to the
 * collaborator that owns the state it touches, which is what makes the
 * dependency bag below a fair summary of what a command can reach.
 *
 * `providers` is a thunk because the provider pair is REPLACED across a
 * reconnect while this object is not.
 *
 * @module
 */

import type { Message } from "@alexkroman1/aai";
import { bytesToPcm16 } from "../_pcm.ts";
import type { Logger } from "../runtime-config.ts";
import type { HeardTracker } from "./pipeline-heard.ts";
import type { PipelineHistory } from "./pipeline-history.ts";
import type { ManualTurn } from "./pipeline-manual-turn.ts";
import type { PipelineProviderSessions } from "./pipeline-providers.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";
import type { Transport } from "./types.ts";

/** Everything one command may reach — see this module's header. @internal */
export interface PipelineCommandDeps {
  lifecycle: {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    audioReady: () => boolean;
    greet: () => void;
  };
  providers: () => PipelineProviderSessions;
  history: PipelineHistory;
  heard: HeardTracker;
  gate: TurnGate;
  /** The false-interruption resume budget — cleared by a deliberate cancel. */
  recovery: { clear: () => void; onUserTurn: () => void };
  /** The utterance edge tracker, reset when a reset starts a new conversation. */
  speechEdges: { reset: () => void };
  /** The silence nudge timer. */
  nudger: { arm: () => void; onUserSpeech: () => void };
  speculation: SpeculationController;
  /** Push-to-talk state — gates the microphone and takes the three turn verbs. */
  manualTurn: ManualTurn;
  /** A reply is in flight or still playing out — what opening a turn interrupts. */
  isBusy: () => boolean;
  abortInFlightTurn: () => void;
  runChainedTurn: (
    text: string,
    crashLabel: string,
    kind?: { isResume?: boolean; synthetic?: boolean },
  ) => void;
  isTerminated: () => boolean;
  log: Logger;
  sid: string;
}

/** Build the transport's command surface. @internal */
export function createPipelineCommands(deps: PipelineCommandDeps): Transport {
  const {
    lifecycle,
    providers,
    history,
    heard,
    gate,
    recovery,
    speechEdges,
    nudger,
    speculation,
    manualTurn,
    abortInFlightTurn,
    runChainedTurn,
    isTerminated,
  } = deps;
  // Said once: an "auto" agent sent a push-to-talk command has a client that
  // disagrees with its declaration, and one line names that for the session.
  let warnedManualOff = false;
  const manualOrWarn = (verb: string): boolean => {
    if (manualTurn.enabled) return true;
    if (!warnedManualOff) {
      warnedManualOff = true;
      deps.log.warn(
        `Client sent ${verb}, but this agent does not declare turnDetection: "manual" — its transcriber ends each turn, so push-to-talk commands are ignored.`,
        { sid: deps.sid },
      );
    }
    return false;
  };
  // The microphone outside a push-to-talk window, sent as SILENCE rather than
  // withheld: the transcriber's clock keeps pace with the call, so the frames
  // around a window line up exactly as they would with the caller quiet.
  const silenced = (pcm: Int16Array): Int16Array =>
    manualTurn.isOpen() ? pcm : new Int16Array(pcm.length);
  return {
    start: () => lifecycle.start(),

    stop: () => {
      // A commit waiting on its final holds a timer; the session is over.
      manualTurn.reset();
      return lifecycle.stop();
    },

    sendUserAudio(bytes: Uint8Array): void {
      if (isTerminated() || !lifecycle.audioReady()) return;
      providers().stt?.sendAudio(silenced(bytesToPcm16(bytes)));
    },

    sendToolResult(_callId: string, _result: string): void {
      // Tool execution stays inside toVercelTools/streamText; a result is
      // handed back to the model there and never routed through the transport,
      // so this verb has nothing to do in pipeline mode. This comment is what
      // makes the block non-empty — `noEmptyBlockStatements` accepts a
      // commented block, so a deliberate no-op costs no lint suppression, and
      // check:hatches counts every suppression whether or not it was earned.
    },

    cancelReply(): void {
      if (isTerminated()) return;
      // A client-initiated cancel is intentional — never resume from it.
      recovery.clear();
      // "Stop responding": strand turns already queued behind the cancelled
      // one. History persistence stays valid — the conversation continues.
      gate.invalidateQueued();
      speculation.discard("reset");
      abortInFlightTurn();
      // Silence after a client-initiated cancel should still nudge.
      nudger.arm();
      // Do NOT report `reply.cancelled` here — the session's own `cancel` command
      // (client-initiated) calls client.cancelled() itself. Barge-in fires
      // onCancelled directly in onSttPartial where the cancel originates here.
    },

    startUserTurn(): boolean {
      if (isTerminated() || !manualOrWarn("user_turn_start")) return false;
      // Opening a turn IS the push-to-talk barge-in: whatever the agent was
      // saying stops, as deliberately as a client cancel — no resume, and the
      // turns queued behind it are stranded.
      const interrupted = deps.isBusy();
      if (interrupted) {
        recovery.clear();
        gate.invalidateQueued();
        speculation.discard("reset");
        abortInFlightTurn();
      }
      manualTurn.start();
      // Pressing the button is presence: restore the budget, restart the window.
      nudger.onUserSpeech();
      return interrupted;
    },

    commitUserTurn(): void {
      if (isTerminated() || !manualOrWarn("user_turn_commit")) return;
      manualTurn.commit();
    },

    clearUserTurn(): void {
      if (isTerminated() || !manualOrWarn("user_turn_clear")) return;
      manualTurn.clear();
      // Nothing was said that the agent will answer, so silence from here is
      // silence after the agent's last turn — the nudge applies again.
      nudger.arm();
    },

    injectTurn(instruction: string): void {
      if (isTerminated()) return;
      // The same path the silence nudge takes — queued on the turn chain, so it
      // waits its turn behind a reply in flight rather than talking over one,
      // and `synthetic` keeps the instruction out of the user transcript while
      // leaving it in the LLM's history where the reply is built from it.
      runChainedTurn(instruction, "Pipeline injected turn crashed", { synthetic: true });
    },

    seedHistory(messages: readonly Message[]): void {
      // Client-resent history on reconnect; restore both views so the resumed
      // agent keeps memory of the prior conversation.
      history.seed(messages);
    },

    onPlaybackProgress(bufferedMs: number): void {
      // The one closed-loop input to a playback estimate that is otherwise
      // bytes-sent times 1.0x — see the `playback_progress` doc in
      // sdk/protocol.ts for what it costs when the client drains slower, and
      // `PlaybackClock.onClientReport` for why it may only ever clamp upward.
      // Ignored after teardown: the clock belongs to a session that is gone.
      if (isTerminated()) return;
      heard.onClientPlaybackReport(bufferedMs);
    },

    reset(): void {
      // Bumped before the abort/history.reset below so the aborted turn's
      // deferred persistence and any queued turns see the change.
      gate.invalidateAll();
      // A reset is user activity: restore the resume budget as well.
      recovery.onUserTurn();
      speechEdges.reset();
      manualTurn.reset();
      speculation.discard("reset");
      abortInFlightTurn();
      history.reset();
      // A reset is user activity: restore the budget, restart the window.
      nudger.onUserSpeech();
      // A reset starts a NEW conversation, so it opens the way every
      // conversation does. Queued after the invalidateAll above, so the
      // greeting turn's epoch is the fresh one and the strand does not catch
      // it; queued on the turn chain, so it runs after the aborted turn
      // unwinds rather than interleaving with it.
      lifecycle.greet();
    },
  };
}
