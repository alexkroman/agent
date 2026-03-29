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
import { callBeforeTurn, callInterceptToolCall, callTextHook } from "./hooks.ts";
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
    if (ctx.maxHistory > 0 && ctx.reply.pendingTools.length > ctx.maxHistory) {
      ctx.reply.pendingTools.shift();
    }
  }
}

export async function handleToolCall(ctx: S2sSessionCtx, detail: S2sToolCall): Promise<void> {
  const { callId, name, args: parsedArgs } = detail;
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
  try {
    const ic = await callInterceptToolCall(ctx.hooks, ctx.id, name, parsedArgs);
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
      ctx.fireHook("afterToolCall", ctx.id, name, parsedArgs, ic.result);
      return;
    }
    if (ic?.type === "args") effectiveArgs = ic.args;
  } catch (err: unknown) {
    ctx.log.warn("interceptToolCall middleware failed (fail-open, tool call proceeds)", {
      err: errorMessage(err),
      tool: name,
    });
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
  ctx.fireHook("afterToolCall", ctx.id, name, effectiveArgs, result);

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
  // biome-ignore lint/suspicious/noExplicitAny: accessing hookable internals for fast-path
  const hooksInternal = (ctx.hooks as any)?._hooks;
  const hasFilterInput = hooksInternal?.filterInput?.length > 0;
  const hasBeforeTurn = hooksInternal?.beforeTurn?.length > 0;

  const processFiltered = (filtered: string) => {
    ctx.pushMessages({ role: "user", content: filtered });
    const fireTurn = () => ctx.fireHook("turn", ctx.id, filtered, HOOK_TIMEOUT_MS);
    if (!hasBeforeTurn) {
      fireTurn();
      return;
    }
    callBeforeTurn(ctx.hooks, ctx.id, filtered)
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

  if (!hasFilterInput) {
    processFiltered(text);
    return;
  }
  callTextHook(ctx.hooks, "filterInput", ctx.id, text)
    .then((filtered) => processFiltered(filtered))
    .catch((err: unknown) => {
      ctx.log.warn("filterInput hook failed", { error: errorMessage(err) });
      processFiltered(text);
    });
}

function chainFilterOutput(
  ctx: S2sSessionCtx,
  text: string,
  emit: (filtered: string) => void,
): void {
  // Fast synchronous path when no filterOutput hooks are registered.
  // hookable stores handlers in _hooks; if the key is absent/empty, skip.
  // biome-ignore lint/suspicious/noExplicitAny: accessing hookable internals for fast-path
  const hasFilterOutput = (ctx.hooks as any)?._hooks?.filterOutput?.length > 0;
  if (!hasFilterOutput) {
    emit(text);
    return;
  }
  ctx.filterChain = ctx.filterChain.then(async () => {
    try {
      const f = await callTextHook(ctx.hooks, "filterOutput", ctx.id, text);
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
    ctx.cancelReply();
    ctx.client.event({ type: "cancelled" });
    return;
  }
  const doneReplyId = ctx.reply.currentReplyId;
  const sendPending = () => {
    if (ctx.reply.currentReplyId !== doneReplyId) {
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
      const last = ctx.conversationMessages.at(-1);
      ctx.fireHook("afterTurn", ctx.id, last?.content ?? "");
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
    ctx.cancelReply();
  });
}
