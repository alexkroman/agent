// Copyright 2025 the AAI authors. MIT license.
/**
 * OpenTelemetry-instrumented session helpers.
 *
 * Extracted from session.ts to keep it under the file-length lint limit.
 * These functions add trace spans and metric counters to the S2S session
 * pipeline: tool calls, user turns, barge-ins, and session lifecycle.
 */

import { errorMessage } from "./_utils.ts";
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

function finishToolCall(ctx: S2sSessionCtx, call_id: string, result: string): void {
  ctx.pendingTools.push({ call_id, result });
  const truncatedResult =
    result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
  ctx.client.event({ type: "tool_call_done", toolCallId: call_id, result: truncatedResult });
}

export async function handleToolCall(ctx: S2sSessionCtx, detail: S2sToolCall): Promise<void> {
  const { call_id, name, args: parsedArgs } = detail;
  const span = tracer.startSpan("tool.call", {
    attributes: {
      "aai.tool.name": name,
      "aai.tool.call_id": call_id,
      "aai.agent": ctx.agent,
      "aai.session.id": ctx.id,
    },
  });
  const startTime = performance.now();

  ctx.client.event({
    type: "tool_call_start",
    toolCallId: call_id,
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
    finishToolCall(ctx, call_id, msg);
    return;
  }

  const refused = ctx.checkTurnLimits(turnConfig, name);
  if (refused !== null) {
    span.setAttribute("aai.tool.refused", true);
    span.end();
    finishToolCall(ctx, call_id, refused);
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

  ctx.log.info("S2S tool call", { tool: name, call_id, args: parsedArgs, agent: ctx.agent });
  toolCallCounter.add(1, { agent: ctx.agent, tool: name });

  // Run middleware tool call interceptors
  let effectiveArgs = parsedArgs;
  if (ctx.hookInvoker?.interceptToolCall) {
    try {
      const ic = await ctx.hookInvoker.interceptToolCall(ctx.id, name, parsedArgs, HOOK_TIMEOUT_MS);
      if (ic?.type === "block") {
        span.setAttribute("aai.tool.blocked", true);
        span.end();
        finishToolCall(ctx, call_id, JSON.stringify({ error: ic.reason }));
        return;
      }
      if (ic?.type === "result") {
        span.setAttribute("aai.tool.cached", true);
        span.end();
        finishToolCall(ctx, call_id, ic.result);
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
      ctx.log.warn("interceptToolCall middleware failed", { err: errorMessage(err) });
    }
  }

  let result: string;
  try {
    result = await ctx.executeTool(name, effectiveArgs, ctx.id, ctx.conversationMessages);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.log.error("Tool execution failed", { tool: name, error: msg });
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
  ctx.log.info("S2S tool result", { tool: name, call_id, resultLength: result.length });
  finishToolCall(ctx, call_id, result);
  span.end();
}

/** Wire all S2S events to the client sink, hooks, and session state. */
export function setupListeners(ctx: S2sSessionCtx, handle: S2sHandle): void {
  handle.on("ready", ({ session_id }) => ctx.log.info("S2S session ready", { session_id }));
  handle.on("session_expired", () => {
    ctx.log.info("S2S session expired");
    handle.close();
  });
  handle.on("speech_started", () => ctx.client.event({ type: "speech_started" }));
  handle.on("speech_stopped", () => ctx.client.event({ type: "speech_stopped" }));
  handle.on("user_transcript_delta", ({ text }) =>
    ctx.client.event({ type: "transcript", text, isFinal: false }),
  );

  handle.on("user_transcript", ({ text }) => {
    ctx.log.info("S2S user transcript", { text });
    turnCounter.add(1, { agent: ctx.agent });
    ctx.client.event({ type: "transcript", text, isFinal: true });
    ctx.client.event({ type: "turn", text });
    ctx.conversationMessages.push({ role: "user", content: text });
    const fireTurn = () => ctx.fireHook("onTurn", (h) => h.onTurn(ctx.id, text, HOOK_TIMEOUT_MS));
    if (!ctx.hookInvoker?.beforeTurn) return fireTurn();
    ctx.hookInvoker
      .beforeTurn(ctx.id, text, HOOK_TIMEOUT_MS)
      .then((reason) => {
        if (reason) {
          ctx.log.info("Turn blocked by middleware", { reason });
          ctx.client.event({ type: "chat", text: reason });
          ctx.client.event({ type: "tts_done" });
        } else fireTurn();
      })
      .catch(() => fireTurn());
  });

  handle.on("reply_started", () => {
    ctx.toolCallCount = 0;
  });
  handle.on("audio", ({ audio }) => ctx.client.playAudioChunk(audio));
  handle.on("agent_transcript_delta", ({ text }) => {
    if (!ctx.hookInvoker?.filterOutput) return ctx.client.event({ type: "chat_delta", text });
    ctx.hookInvoker
      .filterOutput(ctx.id, text, HOOK_TIMEOUT_MS)
      .then((f) => ctx.client.event({ type: "chat_delta", text: f }))
      .catch(() => ctx.client.event({ type: "chat_delta", text }));
  });
  handle.on("agent_transcript", ({ text }) => {
    const emit = (t: string) => {
      ctx.client.event({ type: "chat", text: t });
      ctx.conversationMessages.push({ role: "assistant", content: t });
    };
    if (!ctx.hookInvoker?.filterOutput) return emit(text);
    ctx.hookInvoker
      .filterOutput(ctx.id, text, HOOK_TIMEOUT_MS)
      .then(emit)
      .catch(() => emit(text));
  });

  handle.on("tool_call", (detail) => {
    const p = handleToolCall(ctx, detail).catch((err: unknown) => {
      ctx.log.error("Tool call handler failed", { err: errorMessage(err) });
    });
    ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
  });

  handle.on("reply_done", ({ status }) => {
    if (status === "interrupted") {
      ctx.log.info("S2S reply interrupted (barge-in)");
      bargeInCounter.add(1, { agent: ctx.agent });
      ctx.pendingTools = [];
      ctx.client.event({ type: "cancelled" });
    } else if (ctx.pendingTools.length > 0) {
      for (const tool of ctx.pendingTools) ctx.s2s?.sendToolResult(tool.call_id, tool.result);
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
  });

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
