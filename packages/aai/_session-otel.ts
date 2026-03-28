// Copyright 2025 the AAI authors. MIT license.
/**
 * OpenTelemetry-instrumented session helpers.
 *
 * Extracted from session.ts to keep it under the file-length lint limit.
 * These functions add trace spans and metric counters to the S2S session
 * pipeline: tool calls, user turns, barge-ins, and session lifecycle.
 */

import { errorDetail, errorMessage, toolError } from "./_utils.ts";
import { HOOK_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "./constants.ts";
import type { S2sHandle, S2sToolCall } from "./s2s.ts";
import type { S2sSessionCtx } from "./session.ts";
import {
  bargeInCounter,
  toolCallCounter,
  toolCallDuration,
  toolCallErrorCounter,
  tracer,
  turnCounter,
  turnStepsHistogram,
} from "./telemetry.ts";

export { activeSessionsUpDown, sessionCounter } from "./telemetry.ts";

/**
 * Complete a tool call by truncating the result, emitting a `tool_call_done` event,
 * and accumulating the result in `ctx.reply.pendingTools` — but only if the reply that
 * initiated this call is still active.
 */
function finishToolCall(
  ctx: S2sSessionCtx,
  callId: string,
  result: string,
  replyId: string | null,
): void {
  const truncatedResult =
    result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
  ctx.client.event({ type: "tool_call_done", toolCallId: callId, result: truncatedResult });
  if (replyId !== null && replyId === ctx.reply.currentReplyId) {
    ctx.reply.pendingTools.push({ callId, result });
    // Defensive cap: drop the oldest entry if the array exceeds maxHistory.
    // In practice pendingTools is bounded by maxSteps (default 5), but if
    // maxSteps is disabled or set very high this prevents unbounded growth.
    if (ctx.maxHistory > 0 && ctx.reply.pendingTools.length > ctx.maxHistory) {
      ctx.reply.pendingTools.shift();
    }
  }
}

/**
 * Orchestrate the full tool call pipeline for a single S2S tool invocation.
 *
 * Steps: resolve per-turn config → check step/tool limits → run middleware
 * `interceptToolCall` (which may block, return a cached result, or modify args)
 * → execute the tool → run `afterToolCall` middleware → record metrics and
 * finish via {@link finishToolCall}. Each step is wrapped in an OpenTelemetry
 * span (`tool.call`) with agent/session/tool attributes.
 *
 * @param ctx - The shared mutable session context (see {@link S2sSessionCtx}).
 * @param detail - The tool call details from the S2S API (call ID, name, parsed args).
 */
export async function handleToolCall(ctx: S2sSessionCtx, detail: S2sToolCall): Promise<void> {
  const { callId, name, args: parsedArgs } = detail;
  // Capture the reply ID at call start so finishToolCall can detect
  // whether this tool call's reply was interrupted while we were executing.
  const replyId = ctx.reply.currentReplyId;
  const span = tracer.startSpan("tool.call", {
    attributes: {
      "aai.tool.name": name,
      "aai.tool.call_id": callId,
      "aai.agent": ctx.agent,
      "aai.session.id": ctx.id,
    },
  });
  const startTime = performance.now();

  ctx.client.event({
    type: "tool_call_start",
    toolCallId: callId,
    toolName: name,
    args: parsedArgs,
  });

  let turnConfig: { maxSteps?: number } | null;
  try {
    turnConfig = await ctx.resolveTurnConfig();
  } catch (err: unknown) {
    const msg = `resolveTurnConfig hook error: ${errorMessage(err)}`;
    ctx.log.error(msg);
    span.setStatus({ code: 2, message: msg });
    span.end();
    finishToolCall(ctx, callId, toolError(msg), replyId);
    return;
  }

  const refused = ctx.consumeToolCallStep(turnConfig, name, replyId);
  if (refused !== null) {
    span.setAttribute("aai.tool.refused", true);
    span.end();
    finishToolCall(ctx, callId, refused, replyId);
    return;
  }

  ctx.log.info("S2S tool call", { tool: name, callId, args: parsedArgs, agent: ctx.agent });
  toolCallCounter.add(1, { agent: ctx.agent, tool: name });

  // Run middleware tool call interceptors
  let effectiveArgs = parsedArgs;
  if (ctx.hookInvoker?.interceptToolCall) {
    try {
      const ic = await ctx.hookInvoker.interceptToolCall(ctx.id, name, parsedArgs);
      if (ic?.type === "block") {
        span.setAttribute("aai.tool.blocked", true);
        span.end();
        finishToolCall(ctx, callId, toolError(ic.reason), replyId);
        return;
      }
      if (ic?.type === "result") {
        span.setAttribute("aai.tool.cached", true);
        span.end();
        finishToolCall(ctx, callId, ic.result, replyId);
        ctx.fireHook(
          "afterToolCall",
          (h) => h.afterToolCall?.(ctx.id, name, parsedArgs, ic.result) ?? Promise.resolve(),
        );
        return;
      }
      if (ic?.type === "args") effectiveArgs = ic.args;
    } catch (err: unknown) {
      // Fail-open: middleware error does not block the tool call. The tool
      // proceeds with its original (or partially transformed) args.
      ctx.log.warn("interceptToolCall middleware failed (fail-open, tool call proceeds)", {
        err: errorMessage(err),
        tool: name,
      });
    }
  }

  let result: string;
  try {
    result = await ctx.executeTool(name, effectiveArgs, ctx.id, ctx.conversationMessages);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.log.error("Tool execution failed", { tool: name, error: errorDetail(err) });
    toolCallErrorCounter.add(1, { agent: ctx.agent, tool: name });
    span.setStatus({ code: 2, message: msg });
    span.recordException(err instanceof Error ? err : new Error(msg));
    result = toolError(msg);
  }

  // Run middleware afterToolCall hooks
  if (ctx.hookInvoker?.afterToolCall) {
    ctx.fireHook(
      "afterToolCall",
      (h) => h.afterToolCall?.(ctx.id, name, effectiveArgs, result) ?? Promise.resolve(),
    );
  }

  toolCallDuration.record((performance.now() - startTime) / 1000, { agent: ctx.agent, tool: name });
  ctx.log.info("S2S tool result", { tool: name, callId, resultLength: result.length });
  finishToolCall(ctx, callId, result, replyId);
  span.end();
}

function handleUserTranscript(ctx: S2sSessionCtx, text: string): void {
  ctx.log.info("S2S user transcript", { text });
  turnCounter.add(1, { agent: ctx.agent });
  ctx.client.event({ type: "transcript", text, isFinal: true });
  ctx.client.event({ type: "turn", text });

  // Apply input filters (PII redaction etc.) before the text reaches the LLM.
  // The original text is shown in transcript/turn events; the filtered text
  // is what gets pushed to conversation messages and sent to beforeTurn/LLM.
  const processFiltered = (filtered: string) => {
    ctx.pushMessages({ role: "user", content: filtered });
    const fireTurn = () =>
      ctx.fireHook("onTurn", (h) => h.onTurn(ctx.id, filtered, HOOK_TIMEOUT_MS));
    if (!ctx.hookInvoker?.beforeTurn) {
      fireTurn();
      return;
    }
    ctx.hookInvoker
      .beforeTurn(ctx.id, filtered)
      .then((reason) => {
        if (reason) {
          ctx.log.info("Turn blocked by middleware", { reason });
          ctx.client.event({ type: "chat", text: reason });
          ctx.client.event({ type: "tts_done" });
        } else fireTurn();
      })
      .catch((err: unknown) => {
        ctx.log.warn("beforeTurn hook failed", { error: errorMessage(err) });
        fireTurn();
      });
  };

  if (!ctx.hookInvoker?.filterInput) {
    processFiltered(text);
    return;
  }
  ctx.hookInvoker
    .filterInput(ctx.id, text)
    .then((filtered) => processFiltered(filtered))
    .catch((err: unknown) => {
      ctx.log.warn("filterInput hook failed", { error: errorMessage(err) });
      processFiltered(text);
    });
}

/**
 * Chain a filterOutput call onto `ctx.filterChain` to preserve ordering.
 * On success the filtered text is passed to `emit`; on failure the raw
 * `text` is passed instead (fail-open).
 */
function chainFilterOutput(
  ctx: S2sSessionCtx,
  text: string,
  emit: (filtered: string) => void,
): void {
  const filterOutput = ctx.hookInvoker?.filterOutput;
  if (!filterOutput) {
    emit(text);
    return;
  }
  ctx.filterChain = ctx.filterChain.then(async () => {
    try {
      const f = await filterOutput.call(ctx.hookInvoker, ctx.id, text);
      emit(f);
    } catch (err: unknown) {
      ctx.log.warn("filterOutput hook failed", { error: errorMessage(err) });
      emit(text);
    }
  });
}

function handleAgentTranscriptDelta(ctx: S2sSessionCtx, text: string): void {
  chainFilterOutput(ctx, text, (filtered) => {
    ctx.client.event({ type: "chat_delta", text: filtered });
  });
}

function handleAgentTranscript(ctx: S2sSessionCtx, text: string, interrupted: boolean): void {
  // Chain after any pending deltas to ensure the final transcript
  // is emitted after all deltas are processed.
  chainFilterOutput(ctx, text, (filtered) => {
    ctx.client.event({ type: "chat", text: filtered });
    if (!interrupted) {
      ctx.pushMessages({ role: "assistant", content: filtered });
    }
  });
}

function handleReplyDone(ctx: S2sSessionCtx, status: string | undefined): void {
  if (status === "interrupted") {
    ctx.log.info("S2S reply interrupted (barge-in)");
    bargeInCounter.add(1, { agent: ctx.agent });
    // Invalidate currentReplyId so in-flight tool calls discard their results.
    ctx.cancelReply();
    ctx.client.event({ type: "cancelled" });
    return;
  }
  const doneReplyId = ctx.reply.currentReplyId;
  // Wait for all in-flight tool calls to complete before sending results.
  // Without this, reply_done can fire while async tool execution is still
  // in progress, causing pendingTools to be empty → results never sent → deadlock.
  const sendPending = () => {
    if (ctx.reply.currentReplyId !== doneReplyId) {
      // Stale reply — discard accumulated results to free memory.
      ctx.reply.pendingTools = [];
      return;
    }
    if (ctx.reply.pendingTools.length > 0) {
      for (const tool of ctx.reply.pendingTools) ctx.s2s?.sendToolResult(tool.callId, tool.result);
      ctx.reply.pendingTools = [];
    } else {
      const stepsUsed = ctx.reply.toolCallCount;
      if (stepsUsed > 0) {
        ctx.log.info("Turn complete", { steps: stepsUsed, agent: ctx.agent });
        turnStepsHistogram.record(stepsUsed, { agent: ctx.agent });
      }
      if (ctx.hookInvoker?.afterTurn) {
        const last = ctx.conversationMessages.at(-1);
        ctx.fireHook(
          "afterTurn",
          (h) => h.afterTurn?.(ctx.id, last?.content ?? "") ?? Promise.resolve(),
        );
      }
      ctx.client.playAudioDone();
      ctx.client.event({ type: "tts_done" });
    }
  };
  if (ctx.turnPromise !== null) {
    void ctx.turnPromise.then(sendPending);
  } else {
    sendPending();
  }
}

/**
 * Wire all S2S events to the client sink, hooks, and session state.
 *
 * Registers listeners on the S2S handle for: ready, session expiry, speech
 * start/stop, user/agent transcripts, reply lifecycle, tool calls, audio
 * chunks, errors, and close. Each listener delegates to a focused handler
 * function that updates `ctx` and emits client events.
 *
 * @param ctx - The shared mutable session context.
 * @param handle - The S2S WebSocket handle to listen on.
 */
export function setupListeners(ctx: S2sSessionCtx, handle: S2sHandle): void {
  handle.on("ready", ({ sessionId }) => ctx.log.info("S2S session ready", { sessionId }));
  handle.on("sessionExpired", () => {
    ctx.log.info("S2S session expired");
    handle.close();
  });
  handle.on("speechStarted", () => ctx.client.event({ type: "speech_started" }));
  handle.on("speechStopped", () => ctx.client.event({ type: "speech_stopped" }));
  handle.on("userTranscriptDelta", ({ text }) =>
    ctx.client.event({ type: "transcript", text, isFinal: false }),
  );
  handle.on("userTranscript", ({ text }) => handleUserTranscript(ctx, text));
  handle.on("replyStarted", ({ replyId }) => {
    ctx.beginReply(replyId);
  });
  handle.on("audio", ({ audio }) => ctx.client.playAudioChunk(audio));
  handle.on("agentTranscriptDelta", ({ text }) => handleAgentTranscriptDelta(ctx, text));
  handle.on("agentTranscript", ({ text, interrupted }) =>
    handleAgentTranscript(ctx, text, interrupted),
  );
  handle.on("toolCall", (detail) => {
    const p = handleToolCall(ctx, detail).catch((err: unknown) => {
      ctx.log.error("Tool call handler failed", { err: errorMessage(err) });
    });
    ctx.chainTurn(p);
  });
  handle.on("replyDone", ({ status }) => handleReplyDone(ctx, status));
  handle.on("error", ({ code, message }) => {
    ctx.log.error("S2S error", { code, message });
    ctx.client.event({ type: "error", code: "internal", message });
    handle.close();
  });
  handle.on("close", () => {
    ctx.log.info("S2S closed");
    ctx.s2s = null;
    // Invalidate currentReplyId so in-flight tool calls discard their results.
    ctx.cancelReply();
  });
}
