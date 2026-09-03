// Copyright 2026 the AAI authors. MIT license.
// The body of an ordinary pipeline turn: push the user message, consume the
// LLM stream, and hand the result to one of the three outcomes.
//
// Split out of `pipeline-transport.ts`, which keeps the session-lifetime
// scaffolding (providers, turn machine, reply scaffold, lifecycle). Every
// collaborator here is already built by the time this is constructed, so this
// module composes them and owns no state of its own — the one place where "what
// a turn DOES" reads end to end.

import type { HeardTracker } from "./pipeline-heard.ts";
import type { PipelineHistory } from "./pipeline-history.ts";
import type { TurnLlmRunner } from "./pipeline-llm-stream.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";
import type { TurnOutcome } from "./pipeline-turn-outcome.ts";

/** Run one ordinary (non-greeting) turn for `userText`. */
export type TurnBody = (userText: string, kind?: { synthetic?: boolean }) => Promise<void>;

/** Compose the turn body from the transport's already-built collaborators. */
export function createTurnBody(deps: {
  gate: TurnGate;
  history: PipelineHistory;
  heard: HeardTracker;
  outcome: TurnOutcome;
  consumeLlmStream: TurnLlmRunner;
  speculation: SpeculationController;
  /** The transport's reply scaffold — mints the reply id, signal and drain. */
  runReply: (
    idPrefix: string,
    body: (signal: AbortSignal) => Promise<boolean /* spoke */>,
  ) => Promise<void>;
}): TurnBody {
  const { gate, history, heard, outcome, consumeLlmStream, speculation, runReply } = deps;
  return function runTurn(userText, kind) {
    // An injected prompt (resume / silence nudge) this turn never got to use is
    // rolled back rather than left standing as something the user said — see
    // persistBargeIn.
    const syntheticPrompt = kind?.synthetic === true ? userText : undefined;
    // Claimed BEFORE runReply, which discards any survivor. Null unless
    // preemption is on AND a speculation for exactly this text is adoptable —
    // in which case the reply is already generating and the turn below drains
    // it through the ordinary handler instead of launching a second request.
    const claimed = speculation.take(userText);
    return runReply("pipeline", async (signal) => {
      // reset() bumps this before clearing history — the persistence below
      // runs asynchronously after the abort and must not write the
      // interrupted tail into (or emit a transcript over) a fresh conversation.
      const historyEpoch = gate.historyEpoch();
      history.pushConversation({ role: "user", content: userText });
      history.pushLlm({ role: "user", content: userText });

      let accumulated = "";
      // Portion of `accumulated` already inside persisted step messages.
      let persistedLen = 0;
      const onDelta = (delta: string): void => {
        accumulated += delta;
      };
      const { messages: responseMessages, failed } = await consumeLlmStream(
        signal,
        onDelta,
        () => {
          persistedLen = accumulated.length;
        },
        // Re-parented onto this turn's signal here and not at claim time: a
        // barge-in on the adopted reply must kill the request the speculation
        // started, and until this line nothing owns it.
        claimed?.adopt(signal),
        // A poisoned adoption restarts the run from scratch, so everything
        // accumulated from the abandoned one is about to be regenerated —
        // including, when the model spoke before calling its tool, an opening
        // the caller hears twice. The audio is unavoidable; recording it twice
        // is not. `heard` starts a new reply for the same reason: its spans
        // index THIS string, and the still-playing preamble stays honest
        // because `startReply` deliberately leaves the playback clock alone.
        () => {
          accumulated = "";
          persistedLen = 0;
          heard.startReply();
        },
      );

      if (signal.aborted) {
        outcome.persistBargeIn({
          historyEpoch,
          accumulated,
          heardChars: heard.heard().recordableChars,
          persistedLen,
          stepMessages: responseMessages,
          syntheticPrompt,
        });
        return false;
      }

      // Persist the assistant tool-call message(s) and their `tool` results so
      // the next turn retains tool context, not just the spoken transcript.
      if (responseMessages.length > 0) history.pushLlm(...responseMessages);

      if (outcome.speakRecovery(failed)) return true;

      if (accumulated.length === 0) return false;
      outcome.finishSpokenTurn(accumulated);
      return true;
    });
  };
}
