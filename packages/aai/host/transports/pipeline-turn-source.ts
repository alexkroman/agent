// Copyright 2026 the AAI authors. MIT license.
/**
 * Reply-source selection for one pipeline turn — split out of
 * `pipeline-transport.ts` so that module stays focused on turn
 * orchestration.
 *
 * A turn's reply comes from exactly one of two places (enforced by
 * `resolvePipelineOptions`): the transport's own `streamText` loop
 * (`consumeLlmStream` in `pipeline-stream.ts`), or a pluggable
 * {@link PipelineTurnRunner} — the eve integration, which sources the reply
 * from an eve agent session. Every other voice path in the transport is
 * identical either way.
 */

import type { ModelMessage, Tool } from "ai";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { ToolChoice } from "../../sdk/types.ts";
import type { Logger } from "../runtime-config.ts";
import { createToolCallRepair } from "./pipeline-repair.ts";
import { consumeLlmStream, type LlmStreamResult } from "./pipeline-stream.ts";
import type { PipelineTransportOptions } from "./pipeline-transport-options.ts";
import type { TransportCallbacks } from "./types.ts";

/** Transport-held state the turn source reads on every turn. */
export interface TurnSourceDeps {
  opts: PipelineTransportOptions;
  systemPrompt: string;
  /** Live view of the LLM message history (includes the just-pushed turn). */
  llmMessages: () => ModelMessage[];
  tools: Record<string, Tool>;
  toolChoice: ToolChoice;
  maxSteps: number;
  holdPhrase: string;
  sendTtsText: (text: string) => void;
  callbacks: TransportCallbacks;
  emitError: (code: SessionErrorCode, message: string) => void;
  log: Logger;
}

/** One reply turn, whichever source is configured. */
export type RunTurnStream = (
  userText: string,
  ctl: AbortController,
  onDelta: (delta: string) => void,
  onStepPersisted?: () => void,
) => Promise<LlmStreamResult>;

/** Build the per-turn reply source for the transport. */
export function createTurnSource(deps: TurnSourceDeps): RunTurnStream {
  const { opts, systemPrompt, sendTtsText, callbacks, emitError, log, holdPhrase } = deps;
  return (userText, ctl, onDelta, onStepPersisted) => {
    if (opts.turnRunner) {
      return opts.turnRunner({
        userText,
        systemPrompt,
        messages: deps.llmMessages(),
        ctl,
        onDelta,
        onStepPersisted,
        sendTtsText,
        holdPhrase,
        callbacks,
        emitError,
        log,
        sid: opts.sid,
      });
    }
    const llm = opts.llm;
    // Unreachable: resolvePipelineOptions rejects llm: null without a runner.
    if (!llm) throw new Error("Pipeline transport has neither an llm nor a turnRunner");
    return consumeLlmStream({
      llm,
      systemPrompt,
      messages: deps.llmMessages(),
      tools: deps.tools,
      toolChoice: deps.toolChoice,
      temperature: opts.temperature,
      // Built per turn so the repair holds THIS turn's signal. Reading the
      // mutable `turnController` at repair time raced barge-in: nulled, the
      // repair ran unsignalled (an orphaned billed call); replaced, it held
      // the NEXT turn's signal.
      repairToolCall: createToolCallRepair(llm, log, () => ctl.signal),
      maxSteps: deps.maxSteps,
      holdPhrase,
      sendTtsText,
      callbacks,
      emitError,
      log,
      sid: opts.sid,
      ctl,
      onDelta,
      onStepPersisted,
    });
  };
}
