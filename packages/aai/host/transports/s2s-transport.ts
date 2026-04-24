// Copyright 2026 the AAI authors. MIT license.
// S2S transport — wraps connectS2s and forwards typed callbacks into the SessionCore.

import type { Logger, S2SConfig } from "../runtime-config.ts";
import { consoleLogger } from "../runtime-config.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sSessionConfig,
  type S2sToolSchema,
} from "../s2s.ts";
import type { Transport, TransportCallbacks, TransportSessionConfig } from "./types.ts";

export type S2sTransportOptions = {
  apiKey: string;
  s2sConfig: S2SConfig;
  sessionConfig: S2sSessionConfig;
  toolSchemas: S2sToolSchema[];
  callbacks: TransportCallbacks;
  sid: string;
  agent: string;
  createWebSocket?: CreateS2sWebSocket;
  logger?: Logger;
};

export function createS2sTransport(opts: S2sTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  const createWs = opts.createWebSocket ?? defaultCreateS2sWebSocket;
  let handle: S2sHandle | null = null;
  let currentReplyId: string | null = null;

  async function start(): Promise<void> {
    handle = await connectS2s({
      apiKey: opts.apiKey,
      config: opts.s2sConfig,
      createWebSocket: createWs,
      logger: log,
      sid: opts.sid,
      callbacks: {
        onSessionReady: (providerSessionId) => opts.callbacks.onSessionReady?.(providerSessionId),
        onReplyStarted: (replyId) => {
          currentReplyId = replyId;
          opts.callbacks.onReplyStarted(replyId);
        },
        onReplyDone: () => {
          currentReplyId = null;
          opts.callbacks.onReplyDone();
        },
        onCancelled: () => {
          currentReplyId = null;
          opts.callbacks.onCancelled();
        },
        onAudio: (bytes) => opts.callbacks.onAudioChunk(bytes),
        onUserTranscript: opts.callbacks.onUserTranscript,
        onAgentTranscript: opts.callbacks.onAgentTranscript,
        onToolCall: opts.callbacks.onToolCall,
        onSpeechStarted: opts.callbacks.onSpeechStarted,
        onSpeechStopped: opts.callbacks.onSpeechStopped,
        onSessionExpired: () => {
          log.info("S2S session expired", { sid: opts.sid });
          handle?.close();
        },
        onError: (err) => opts.callbacks.onError("internal", err.message),
        onClose: (code, reason) => {
          if (currentReplyId !== null) {
            log.warn("S2S closed with active reply", {
              sid: opts.sid,
              agent: opts.agent,
              activeReplyId: currentReplyId,
              code,
              reason,
            });
            opts.callbacks.onError("connection", `S2S closed mid-reply (code=${code})`);
          } else {
            log.info("S2S closed", { code, reason });
          }
        },
      },
    });
    handle.updateSession(opts.sessionConfig);
  }

  async function stop(): Promise<void> {
    handle?.close();
    handle = null;
  }

  return {
    start,
    stop,
    sendUserAudio(bytes) {
      handle?.sendAudio(bytes);
    },
    sendToolResult(callId, result) {
      handle?.sendToolResult(callId, result);
    },
    cancelReply() {
      // AssemblyAI S2S doesn't expose an explicit cancel RPC — reply is
      // cancelled when the user speaks. Our `onCancel` from the client is
      // a best-effort signal.
      currentReplyId = null;
    },
    updateSession(config: TransportSessionConfig) {
      handle?.updateSession({
        systemPrompt: config.systemPrompt,
        tools: (config.tools ?? []) as S2sToolSchema[],
        ...(config.greeting !== undefined ? { greeting: config.greeting } : {}),
      });
    },
  };
}
