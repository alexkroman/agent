// Copyright 2026 the AAI authors. MIT license.
// The body of an ordinary pipeline turn: push the user message, consume the
// LLM stream, and hand the result to one of the three outcomes.
//
// Split out of `pipeline-transport.ts`, which keeps the session-lifetime
// scaffolding (providers, turn machine, reply scaffold, lifecycle). Every
// collaborator here is already built by the time this is constructed, so this
// module composes them and owns no state of its own — the one place where "what
// a turn DOES" reads end to end.

import type { ModelMessage } from "ai";
import type { FatalToolLatch } from "../tool-error-policy.ts";
import type { UsageMeter } from "../usage-meter.ts";
import type { SpeechGate, TurnGuardrails } from "./pipeline-guardrails.ts";
import type { HeardTracker } from "./pipeline-heard.ts";
import type { PipelineHistory } from "./pipeline-history.ts";
import type { TurnLlmRunner } from "./pipeline-llm-stream.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";
import type { TurnOutcome } from "./pipeline-turn-outcome.ts";
import type { EmitError, SendTtsText } from "./types.ts";

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
  /** This session's guardrails — `NO_GUARDRAILS` for almost every agent. */
  guardrails: TurnGuardrails;
  /** The holdable funnel, so a blocked reply can be dropped unspoken. */
  speech: SpeechGate;
  /** Reset per turn; read by the LLM runner. See `tool-error-policy.ts`. */
  fatalTool: FatalToolLatch;
  /** The session's token meter, when the host built one. */
  usage?: UsageMeter | undefined;
  /** The gated send — how a refusal or a replacement reaches the caller. */
  sendTtsText: SendTtsText;
  /** Report a turn-level error (never fatal — a failing turn is not a failing session). */
  emitError: EmitError;
}): TurnBody {
  const {
    gate,
    history,
    heard,
    outcome,
    consumeLlmStream,
    speculation,
    runReply,
    guardrails,
    speech,
    fatalTool,
    usage,
    sendTtsText,
    emitError,
  } = deps;

  /**
   * Say one sentence the MODEL did not produce, and record it as the agent's
   * turn: a guardrail's refusal, or its replacement for a blocked reply.
   *
   * Recorded rather than merely spoken, unlike the two recovery phrases: those
   * are the framework apologizing for itself, where this is the agent's actual
   * answer for this turn. A caller who asks the same thing again should be
   * talking to an agent that remembers refusing.
   */
  function speakInstead(text: string): void {
    sendTtsText(text);
    history.pushLlm({ role: "assistant", content: text });
    outcome.finishSpokenTurn(text);
  }

  /**
   * Everything between the user message landing in history and the request
   * going out: the input guardrail, the token budget, and the speech hold.
   *
   * Answers `undefined` to mean "carry on"; a boolean is the turn's `spoke`
   * result and the caller returns it untouched. Its own function because all
   * three are refusals of the same kind — reasons this turn never reaches the
   * model — and because `runTurn` reads as one story only while the branches
   * that end it early are somewhere else.
   */
  async function beforeModel(userText: string, signal: AbortSignal): Promise<boolean | undefined> {
    // BEFORE the model, which is the whole point of an input guardrail: a
    // refusal here costs no tokens and the model never sees the utterance. The
    // user message is pushed by the caller regardless — the caller DID say it,
    // and a conversation that silently forgets a refused turn is one the model
    // will answer inconsistently on the next.
    const refused = await guardrails.checkInput(userText);
    if (refused !== undefined) {
      if (signal.aborted) return false;
      speakInstead(refused);
      return true;
    }
    // The budget, checked where a request is about to be made rather than
    // mid-stream — see `usage-meter.ts`. FATAL, which for this reporter is the
    // omitted third argument: every later turn would be refused the same way,
    // and a client left interactive would be talking to nothing.
    const exhausted = usage?.exhausted();
    if (exhausted !== undefined) {
      emitError("internal", exhausted);
      return false;
    }
    // Hold every recordable send until the reply can be judged whole. A no-op
    // unless this session declares an output guardrail; filler still passes
    // straight through, so the caller hears the dead-air cover during the wait.
    if (guardrails.holdsSpeech) speech.hold();
    return undefined;
  }

  /**
   * The three ordinary endings, plus the one the output guardrail adds.
   *
   * The guardrail runs FIRST of the four: a blocked reply must not reach the
   * model's history, and `speakRecovery` would speak into a gate still holding.
   */
  async function afterModel(
    signal: AbortSignal,
    accumulated: string,
    responseMessages: readonly ModelMessage[],
    failed: boolean,
  ): Promise<boolean> {
    const blocked =
      accumulated.length === 0 ? undefined : await guardrails.checkOutput(accumulated);
    if (blocked !== undefined) {
      // The model's words are dropped unspoken, and its step messages go with
      // them — the tool calls included. A history holding results the agent
      // never reported is one where the agent silently knows things it did not
      // say; the cost is that a later turn may call those tools again.
      speech.discard();
      if (signal.aborted) return false;
      speakInstead(blocked);
      return true;
    }
    speech.release();
    // Persist the assistant tool-call message(s) and their `tool` results so
    // the next turn retains tool context, not just the spoken transcript.
    if (responseMessages.length > 0) history.pushLlm(...responseMessages);
    if (outcome.speakRecovery(failed)) return true;
    if (accumulated.length === 0) return false;
    outcome.finishSpokenTurn(accumulated);
    return true;
  }
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
      // A fresh signal for this turn's tools to abort, and no error carried
      // over from the last one.
      fatalTool.reset();
      // reset() bumps this before clearing history — the persistence below
      // runs asynchronously after the abort and must not write the
      // interrupted tail into (or emit a transcript over) a fresh conversation.
      const historyEpoch = gate.historyEpoch();
      history.pushConversation({ role: "user", content: userText });
      history.pushLlm({ role: "user", content: userText });

      const stopped = await beforeModel(userText, signal);
      if (stopped !== undefined) return stopped;

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
        // Nothing held may be spoken into a turn the caller talked over.
        speech.discard();
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

      return await afterModel(signal, accumulated, responseMessages, failed);
    });
  };
}
