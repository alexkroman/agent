// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things one turn does about `ToolDef.messages` — bind the speech
 * channel its tool calls speak through, and carry a verbatim completion out
 * with the step messages.
 *
 * Split out of `pipeline-llm-stream.ts` at the 500-line cap. They belong
 * together and nowhere else: both are about the ONE mechanism by which a tool's
 * own words reach the turn around it, from opposite ends — what goes out to the
 * caller, and what comes back to the model's view of the conversation. The
 * runner itself is `../tool-messages-runner.ts`.
 */

import type { ModelMessage } from "ai";
import { awaitSpokenEstimate, type ToolSpeechController } from "../tool-messages-runner.ts";
import type { StepResult } from "./pipeline-llm-types.ts";
import type { TtsTextCoalescer } from "./pipeline-stream.ts";

/**
 * Bind the turn's speech channel for whatever `ToolDef.messages` its tool
 * calls declare, and answer the thunk that unbinds it.
 *
 * The COALESCER is read through a thunk rather than captured, and that is the
 * load-bearing part: it is per-turn AND replaced outright on a
 * poisoned-adoption restart, so a captured one would send a tool's line into a
 * batch belonging to a run that was abandoned. One binding survives the
 * restart because every member reads the live one.
 *
 * `record` is passed straight through and never forced here. The runner's
 * `emitFiller` is the only producer of a `false` and a verbatim completion the
 * only producer of a `true`, which is why `record()` goes to `onDelta`: that
 * line IS the agent's answer and belongs in the turn's transcript.
 *
 * A no-op for a caller with no controller — a speculation, a text agent, a
 * subagent — which is what makes this feature voice-only by construction. It
 * answers a no-op THUNK in that case rather than `undefined`, so the unbind in
 * `consumeLlmStream`'s `finally` is an unconditional call: that function sits
 * at its cognitive-complexity ceiling and an optional chain costs a point.
 */
export function bindToolSpeech(
  toolSpeech: ToolSpeechController | undefined,
  deps: {
    coalescer: () => TtsTextCoalescer;
    onDelta: (delta: string) => void;
    callerSpeaking: (() => boolean) | undefined;
  },
): () => void {
  if (toolSpeech === undefined) return () => undefined;
  toolSpeech.beginTurn();
  return toolSpeech.bind({
    send: (text, opts) => deps.coalescer().send(text, { record: opts.record }),
    boundary: () => deps.coalescer().boundary(),
    record: (text) => deps.onDelta(text),
    callerSpeaking: deps.callerSpeaking ?? ((): boolean => false),
    awaitSpoken: awaitSpokenEstimate,
  });
}

/**
 * Every completed step's response messages, plus the one message no step
 * produced.
 *
 * A `role: "assistant"` tool completion is spoken from inside the tool call and
 * STOPS the loop (see `startLlmStream`'s `stopWhen`), so the sentence the
 * caller heard is in no step's messages. Appending it here is what keeps the
 * model's view of the conversation honest — without it the next turn's model
 * has no idea the agent said it, and answers an "as you mentioned" question
 * from a conversation it half has.
 */
export function stepMessages(
  settled: readonly StepResult[],
  toolSpeech: ToolSpeechController | undefined,
): ModelMessage[] {
  const messages = settled.flatMap((step) => step.response.messages);
  const spoken = toolSpeech?.verbatim();
  if (spoken !== undefined) messages.push({ role: "assistant", content: spoken });
  return messages;
}
