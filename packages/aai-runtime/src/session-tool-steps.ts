// Copyright 2026 the AAI authors. MIT license.
/**
 * A reply's tool calls: the step budget, the execution, and where the result
 * lands.
 *
 * Split out of `session-core.ts` at the 500-line cap, along a seam that file's
 * own header already named — it says the session owns "reply lifecycle,
 * conversation history, idle timeout, and tool-step enforcement", and this is
 * the last of the four. What stays behind is everything about the TURN; what
 * moves here is everything about one CALL inside it.
 *
 * The two properties worth reading before touching this:
 *
 * - **A result is bound to the reply that ISSUED the call**, by object identity.
 *   A barge-in or reset swaps in a fresh reply object mid-call, and the settling
 *   result must land in the now-orphaned one — writing it into the current
 *   reply's `pendingTools` would either hang the turn (an S2S provider waits for
 *   a result it never asked for) or mis-route it.
 * - **The step budget refuses rather than truncates.** Past `maxSteps` the call
 *   is answered with a failure telling the model to speak, so the turn ends with
 *   an answer instead of silence. See the `maxSteps` row in the SDK guide for why
 *   the cap and the forced final answer are one mechanism.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { capToolResult } from "@alexkroman1/aai/internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import type { SessionEmitter } from "./session-emitter.ts";

/** One settled tool call, awaiting the flush that hands it to the transport. */
export type PendingTool = { callId: string; result: string };

/** The mutable per-reply state a tool call reads and writes. */
export type ReplyToolState = {
  currentReplyId: string | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
  abort: AbortController;
  flushedAwaitingContinuation: boolean;
};

/** What one session's tool-step runner needs from the session around it. */
export type ToolStepDeps = {
  sessionId: string;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  emit: SessionEmitter["emit"];
  log: Logger;
  /** The live conversation, snapshotted per call. */
  history: () => readonly Message[];
  /** True in relay/host mode, where the relay executor emits `tool.called` itself. */
  relayed: boolean;
};

/**
 * Run one tool call against `reply`, returning the promise the turn chain must
 * wait on — or `undefined` when nothing was started (the step budget refused it,
 * or the reply had already ended).
 *
 * @internal
 */
export function runToolStep(
  reply: ReplyToolState,
  call: { callId: string; name: string; args: Record<string, unknown> },
  deps: ToolStepDeps,
): Promise<void> | undefined {
  const { callId, name, args } = call;
  const { emit, log, agentConfig } = deps;
  // In relay/host mode the relay `executeTool` emits the `tool.called` frame
  // itself (keyed by callId), so emitting here too would duplicate it — a
  // duplicate the client RUNS twice, corrupting write state.
  if (!deps.relayed) emit({ type: "tool.called", toolCallId: callId, toolName: name, args });
  if (reply.currentReplyId === null) {
    log.warn("tool.called with no active reply", { sid: deps.sessionId, name });
    return undefined;
  }
  reply.flushedAwaitingContinuation = false;
  reply.toolCallCount++;
  const maxSteps = agentConfig.maxSteps;
  if (maxSteps !== undefined && reply.toolCallCount > maxSteps) {
    log.info("maxSteps exceeded; refusing tool call", {
      toolCallCount: reply.toolCallCount,
      maxSteps,
    });
    reply.pendingTools.push({
      callId,
      result: serializeToolFailure("Maximum tool steps reached. Please respond to the user now."),
    });
    emit({ type: "tool.completed", toolCallId: callId, result: "{}" });
    return undefined;
  }
  return (async () => {
    try {
      // Snapshot history: the live array is push/spliced by transcript events
      // while the tool runs (mirrors to-vercel-tools.ts). The reply's abort
      // signal lets barge-in/reset/stop settle the call.
      const result = await deps.executeTool(name, args, deps.sessionId, [...deps.history()], {
        toolCallId: callId,
        signal: reply.abort.signal,
      });
      // Full result goes to the provider; the client `tool.completed` event is
      // capped by the wire schema (MAX_TOOL_RESULT_CHARS), so truncate it or the
      // client silently drops the whole message and the UI tool-call block stays
      // "pending" forever.
      reply.pendingTools.push({ callId, result });
      emit({ type: "tool.completed", toolCallId: callId, result: capToolResult(result) });
    } catch (err) {
      const message = errorMessage(err);
      reply.pendingTools.push({ callId, result: serializeToolFailure(message) });
      emit({ type: "tool.completed", toolCallId: callId, result: capToolResult(message) });
    }
  })();
}
