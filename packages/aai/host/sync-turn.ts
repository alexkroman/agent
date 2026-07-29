// Copyright 2026 the AAI authors. MIT license.
/**
 * Sync turns — one complete conversational exchange per HTTP request.
 *
 * The connectionless counterpart of the pipeline transport: no WebSocket to
 * the client and no streaming sessions to the providers. The client
 * endpoints speech itself (e.g. with a WebRTC/VAD capture pipeline), sends
 * one utterance (or committed text) plus the conversation history, and gets
 * the whole turn back in the response:
 *
 * - **STT** via the provider's one-shot batch capability
 *   ({@link SttOpener.transcribeClip} — AssemblyAI's Sync API).
 * - **LLM** via `streamText` (plain HTTPS), drained to completion
 *   server-side — tools execute exactly as they do on the pipeline path.
 * - **TTS** via the provider's one-shot synthesis capability
 *   ({@link TtsOpener.synthesizeClip} — Cartesia's bytes endpoint).
 *
 * The server holds no session state between turns: history travels with
 * each request, capped to the agent's history window.
 */

import { randomUUID } from "node:crypto";
import { type ModelMessage, stepCountIs, streamText } from "ai";
import type { AgentConfig, ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import { DEFAULT_MAX_HISTORY, DEFAULT_MAX_STEPS } from "../sdk/constants.ts";
import type { SyncTurnRequest, SyncTurnResponse } from "../sdk/sync.ts";
import type { Message } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { base64ToUint8, uint8ToBase64 } from "./_base64.ts";
import { resolveApiKey } from "./providers/resolve.ts";
import type { Logger } from "./runtime-config.ts";
import type { ResolvedPipelineProviders } from "./runtime-transport.ts";
import { toVercelTools } from "./to-vercel-tools.ts";

/**
 * A sync-turn failure with the HTTP status it should answer with:
 * 422 when the agent's providers can't serve the request shape (audio in
 * with no batch STT), 502 when an upstream provider call failed.
 */
export class SyncTurnError extends Error {
  readonly status: number;
  constructor(message: string, options: ErrorOptions & { status: number }) {
    super(message, options);
    this.name = "SyncTurnError";
    this.status = options.status;
  }
}

/** Runtime-scoped state a sync-turn runner closes over. */
export type SyncTurnDeps = {
  agentConfig: AgentConfig;
  providers: ResolvedPipelineProviders;
  /** Credential env (the runtime's `providerEnv`), never `ctx.env`. */
  env: Record<string, string>;
  toolSchemas: ToolSchema[];
  executeTool: ExecuteTool;
  /** The runtime's cached per-day system prompt builder. */
  systemPrompt: () => string;
  /** Fetch override (see RuntimeOptions.fetch) for the one-shot provider calls. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Sample rate of synthesized reply audio (the runtime's TTS-side rate). */
  ttsSampleRate: number;
  logger: Logger;
};

/** Trim client-replayed history to the agent's window (drop oldest first). */
function trimHistory(history: SyncTurnRequest["history"], max: number): Message[] {
  const kept = history.length > max ? history.slice(history.length - max) : history;
  return kept.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Build a sync-turn runner for a pipeline-mode runtime. Each call to the
 * returned function is one independent turn: transcribe (when audio came
 * in), run the LLM loop with the agent's tools, synthesize the reply.
 *
 * `sessionId` names the turn for tool execution (`executeTool`'s session
 * scope); callers that keep per-session state elsewhere (the platform's
 * guest sandbox) pass their own id so they can clean that state up after
 * the turn. Omitted, each turn gets a fresh `sync:` id.
 */
export function createSyncTurnRunner(
  deps: SyncTurnDeps,
): (req: SyncTurnRequest, sessionId?: string) => Promise<SyncTurnResponse> {
  const { agentConfig, providers, env, toolSchemas, executeTool, logger } = deps;
  const maxSteps = agentConfig.maxSteps ?? DEFAULT_MAX_STEPS;

  async function transcribe(req: SyncTurnRequest): Promise<string> {
    if (req.text !== undefined) return req.text;
    const transcribeClip = providers.stt.opener.transcribeClip?.bind(providers.stt.opener);
    if (!transcribeClip) {
      throw new SyncTurnError(
        `STT provider "${providers.stt.opener.name}" has no one-shot transcription; ` +
          "send text, or use a provider with a sync API (e.g. assemblyAI)",
        { status: 422 },
      );
    }
    // The schema guarantees audio+sampleRate travel together.
    const pcm = base64ToUint8(req.audio ?? "");
    const sampleRate = req.sampleRate ?? 0;
    try {
      return (
        await transcribeClip(pcm, sampleRate, {
          apiKey: resolveApiKey(providers.stt.envVar, env),
          fetch: deps.fetch,
        })
      ).trim();
    } catch (err) {
      throw new SyncTurnError(`Sync transcription failed: ${errorMessage(err)}`, {
        status: 502,
        cause: err,
      });
    }
  }

  async function runLlm(
    history: Message[],
    transcript: string,
    sessionId: string,
  ): Promise<string> {
    const messages: Message[] = [...history, { role: "user", content: transcript }];
    const modelMessages: ModelMessage[] = messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    const tools = toVercelTools(toolSchemas, {
      executeTool,
      sessionId,
      messages: () => messages,
    });
    let text = "";
    try {
      const result = streamText({
        model: providers.llm,
        system: deps.systemPrompt(),
        messages: modelMessages,
        ...(toolSchemas.length > 0 ? { tools, toolChoice: agentConfig.toolChoice ?? "auto" } : {}),
        stopWhen: stepCountIs(maxSteps),
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") text += part.text ?? "";
        // streamText surfaces provider failures as stream parts, not
        // rejections — rethrow so a dead turn is an error, not "".
        else if (part.type === "error") throw part.error;
      }
    } catch (err) {
      throw new SyncTurnError(`LLM turn failed: ${errorMessage(err)}`, { status: 502, cause: err });
    }
    return text.trim();
  }

  async function synthesize(
    reply: string,
  ): Promise<Pick<SyncTurnResponse, "audio" | "sampleRate" | "ttsError">> {
    // Text-only agents (tts: none()) and providers without a one-shot
    // endpoint answer with text alone — the response shape says so.
    const synthesizeClip = providers.tts?.opener.synthesizeClip?.bind(providers.tts.opener);
    if (!(providers.tts && synthesizeClip) || reply.length === 0) return {};
    try {
      const pcm = await synthesizeClip(reply, {
        sampleRate: deps.ttsSampleRate,
        apiKey: resolveApiKey(providers.tts.envVar, env),
        fetch: deps.fetch,
      });
      return { audio: uint8ToBase64(pcm), sampleRate: deps.ttsSampleRate };
    } catch (err) {
      // The reply already exists — losing it over a synthesis failure would
      // punish the wrong side. Degrade loudly instead: text + ttsError.
      const msg = errorMessage(err);
      logger.warn(`Sync turn TTS failed: ${msg}`);
      return { ttsError: msg };
    }
  }

  return async function runSyncTurn(
    req: SyncTurnRequest,
    sessionId: string = `sync:${randomUUID()}`,
  ): Promise<SyncTurnResponse> {
    const transcript = await transcribe(req);
    if (transcript.length === 0) {
      throw new SyncTurnError("transcription produced no speech", { status: 422 });
    }
    const history = trimHistory(req.history, DEFAULT_MAX_HISTORY);
    const reply = await runLlm(history, transcript, sessionId);
    const spoken = await synthesize(reply);
    return { transcript, reply, ...spoken };
  };
}
