// Copyright 2025 the AAI authors. MIT license.
/**
 * OpenTelemetry-instrumented session helpers.
 *
 * Extracted from session.ts to keep it under the file-length lint limit.
 * These functions add trace spans and metric counters to the S2S session
 * pipeline: tool calls, user turns, barge-ins, and session lifecycle.
 */

import { errorDetail, errorMessage } from "./_utils.ts";
import { HOOK_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "./protocol.ts";
import type { S2sHandle, S2sToolCall } from "./s2s.ts";
import type { S2sSessionCtx } from "./session.ts";
import {
  bargeInCounter,
  toolCallCounter,
  toolCallDuration,
  toolCallErrorCounter,
  tracer,
  turnCounter,
} from "./telemetry.ts";

export { activeSessionsUpDown, sessionCounter } from "./telemetry.ts";

/**
 * Complete a tool call by truncating the result, emitting a `tool_call_done` event,
 * and accumulating the result in `ctx.pendingTools` — but only if the reply that
 * initiated this call is still active. A barge-in bumps `ctx.replyGeneration`,
 * so late-finishing tools from an interrupted reply are silently discarded instead
 * of leaking into the next reply's pending tools.
 */
function finishToolCall(
  ctx: S2sSessionCtx,
  callId: string,
  result: string,
  generation: number,
): void {
  const truncatedResult =
    result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
  ctx.client.event({ type: "tool_call_done", toolCallId: callId, result: truncatedResult });
  // Only accumulate if this tool call belongs to the current reply.
  // A barge-in bumps replyGeneration, so late-finishing tools from the
  // interrupted reply are silently discarded instead of leaking into
  // the next reply's pendingTools.
  if (ctx.replyGeneration === generation) {
    ctx.pendingTools.push({ callId, result });
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
  // Capture the reply generation at call start so finishToolCall can detect
  // whether this tool call's reply was interrupted while we were executing.
  const generation = ctx.replyGeneration;
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

  let turnConfig: { maxSteps?: number; activeTools?: string[] } | null;
  try {
    turnConfig = await ctx.resolveTurnConfig();
  } catch (err: unknown) {
    const msg = `resolveTurnConfig hook error: ${errorMessage(err)}`;
    ctx.log.error(msg);
    span.setStatus({ code: 2, message: msg });
    span.end();
    finishToolCall(ctx, callId, msg, generation);
    return;
  }

  const refused = ctx.consumeToolCallStep(turnConfig, name, generation);
  if (refused !== null) {
    span.setAttribute("aai.tool.refused", true);
    span.end();
    finishToolCall(ctx, callId, refused, generation);
    return;
  }

  ctx.fireHook("onStep", (h) =>
    h.onStep(
      ctx.id,
      {
        stepNumber: ctx.toolCallCount - 1,
        toolCalls: [{ toolName: name, args: parsedArgs }],
        text: "",
      },
      HOOK_TIMEOUT_MS,
    ),
  );

  ctx.log.info("S2S tool call", { tool: name, callId, args: parsedArgs, agent: ctx.agent });
  toolCallCounter.add(1, { agent: ctx.agent, tool: name });

  // Run middleware tool call interceptors
  let effectiveArgs = parsedArgs;
  if (ctx.hookInvoker?.interceptToolCall) {
    try {
      const ic = await ctx.hookInvoker.interceptToolCall(ctx.id, name, parsedArgs, HOOK_TIMEOUT_MS);
      if (ic?.type === "block") {
        span.setAttribute("aai.tool.blocked", true);
        span.end();
        finishToolCall(ctx, callId, JSON.stringify({ error: ic.reason }), generation);
        return;
      }
      if (ic?.type === "result") {
        span.setAttribute("aai.tool.cached", true);
        span.end();
        finishToolCall(ctx, callId, ic.result, generation);
        ctx.fireHook(
          "afterToolCall",
          (h) =>
            h.afterToolCall?.(ctx.id, name, parsedArgs, ic.result, HOOK_TIMEOUT_MS) ??
            Promise.resolve(),
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

  const onUpdate = (data: unknown): void => {
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    const truncated =
      serialized.length > MAX_TOOL_RESULT_CHARS
        ? serialized.slice(0, MAX_TOOL_RESULT_CHARS)
        : serialized;
    ctx.client.event({ type: "tool_call_update", toolCallId: callId, data: truncated });
  };

  let result: string;
  try {
    result = await ctx.executeTool(name, effectiveArgs, ctx.id, ctx.conversationMessages, onUpdate);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.log.error("Tool execution failed", { tool: name, error: errorDetail(err) });
    toolCallErrorCounter.add(1, { agent: ctx.agent, tool: name });
    span.setStatus({ code: 2, message: msg });
    span.recordException(err instanceof Error ? err : new Error(msg));
    result = JSON.stringify({ error: msg });
  }

  // Run middleware afterToolCall hooks
  if (ctx.hookInvoker?.afterToolCall) {
    ctx.fireHook(
      "afterToolCall",
      (h) =>
        h.afterToolCall?.(ctx.id, name, effectiveArgs, result, HOOK_TIMEOUT_MS) ??
        Promise.resolve(),
    );
  }

  toolCallDuration.record((performance.now() - startTime) / 1000, { agent: ctx.agent, tool: name });
  ctx.log.info("S2S tool result", { tool: name, callId, resultLength: result.length });
  finishToolCall(ctx, callId, result, generation);
  span.end();
}

function handleUserTranscript(ctx: S2sSessionCtx, text: string): void {
  ctx.log.info("S2S user transcript", { text });
  turnCounter.add(1, { agent: ctx.agent });
  ctx.client.event({ type: "transcript", text, isFinal: true });
  ctx.client.event({ type: "turn", text });
  ctx.pushMessages({ role: "user", content: text });
  const fireTurn = () => ctx.fireHook("onTurn", (h) => h.onTurn(ctx.id, text, HOOK_TIMEOUT_MS));
  if (!ctx.hookInvoker?.beforeTurn) {
    fireTurn();
    return;
  }
  ctx.hookInvoker
    .beforeTurn(ctx.id, text, HOOK_TIMEOUT_MS)
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
}

function handleAgentTranscriptDelta(ctx: S2sSessionCtx, text: string): void {
  const filterOutput = ctx.hookInvoker?.filterOutput;
  if (!filterOutput) {
    ctx.client.event({ type: "chat_delta", text });
    return;
  }
  // Chain filter calls sequentially to preserve ordering. Without this,
  // concurrent filterOutput calls could resolve out of order, producing
  // garbled text on the client.
  ctx.filterChain = ctx.filterChain.then(async () => {
    try {
      const f = await filterOutput.call(ctx.hookInvoker, ctx.id, text, HOOK_TIMEOUT_MS);
      ctx.client.event({ type: "chat_delta", text: f });
    } catch (err: unknown) {
      ctx.log.warn("filterOutput hook failed", { error: errorMessage(err) });
      ctx.client.event({ type: "chat_delta", text });
    }
  });
}

function handleAgentTranscript(ctx: S2sSessionCtx, text: string): void {
  const emit = (t: string) => {
    ctx.client.event({ type: "chat", text: t });
    ctx.pushMessages({ role: "assistant", content: t });
  };
  const filterOutput = ctx.hookInvoker?.filterOutput;
  if (!filterOutput) {
    emit(text);
    return;
  }
  // Chain after any pending deltas to ensure the final transcript
  // is emitted after all deltas are processed.
  ctx.filterChain = ctx.filterChain.then(async () => {
    try {
      const f = await filterOutput.call(ctx.hookInvoker, ctx.id, text, HOOK_TIMEOUT_MS);
      emit(f);
    } catch (err: unknown) {
      ctx.log.warn("filterOutput hook failed", { error: errorMessage(err) });
      emit(text);
    }
  });
}

function handleReplyDone(ctx: S2sSessionCtx, status: string | undefined): void {
  if (status === "interrupted") {
    ctx.log.info("S2S reply interrupted (barge-in)");
    bargeInCounter.add(1, { agent: ctx.agent });
    // Bump generation so in-flight tool calls discard their results
    // instead of pushing to pendingTools (checked in finishToolCall).
    ctx.replyGeneration++;
    ctx.pendingTools = [];
    ctx.client.event({ type: "cancelled" });
    return;
  }
  // Wait for all in-flight tool calls to complete before sending results.
  // Without this, reply_done can fire while async tool execution is still
  // in progress, causing pendingTools to be empty → results never sent → deadlock.
  const sendPending = () => {
    if (ctx.pendingTools.length > 0) {
      for (const tool of ctx.pendingTools) ctx.s2s?.sendToolResult(tool.callId, tool.result);
      ctx.pendingTools = [];
    } else {
      if (ctx.hookInvoker?.afterTurn) {
        const last = ctx.conversationMessages.at(-1);
        ctx.fireHook(
          "afterTurn",
          (h) => h.afterTurn?.(ctx.id, last?.content ?? "", HOOK_TIMEOUT_MS) ?? Promise.resolve(),
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
  handle.on("replyStarted", () => {
    ctx.toolCallCount = 0;
    ctx.replyGeneration++;
    ctx.pendingTools = [];
    // Reset the turn promise chain so stale resolved promises from
    // a previous reply don't cause sendPending to execute immediately
    // in handleReplyDone before current-reply tool calls finish.
    ctx.turnPromise = null;
    // Reset filter chain so stale filter promises don't block new deltas.
    ctx.filterChain = Promise.resolve();
  });
  handle.on("audio", ({ audio }) => ctx.client.playAudioChunk(audio));
  handle.on("agentTranscriptDelta", ({ text }) => handleAgentTranscriptDelta(ctx, text));
  handle.on("agentTranscript", ({ text }) => handleAgentTranscript(ctx, text));
  handle.on("toolCall", (detail) => {
    const p = handleToolCall(ctx, detail).catch((err: unknown) => {
      ctx.log.error("Tool call handler failed", { err: errorMessage(err) });
    });
    ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
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
  });
}
