// Copyright 2026 the AAI authors. MIT license.
// Unified session — owns reply lifecycle, conversation history, idle timeout,
// and tool-step enforcement. Replaces session.ts + pipeline-session.ts.

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import type { ClientSink, ErrorCode } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { Transport } from "./transports/types.ts";

type PendingTool = { callId: string; result: string };

type ReplyState = {
  currentReplyId: string | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
};

export type SessionCoreOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  transport: Transport;
  logger?: Logger;
  maxHistory?: number;
};

export type SessionCore = {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Inbound from client (decoded by ws-handler)
  onAudio(bytes: Uint8Array): void;
  onAudioReady(): void;
  onCancel(): void;
  onReset(): void;
  onHistory(messages: readonly Message[]): void;
  // Inbound from transport (spec §4.2)
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudioChunk(bytes: Uint8Array): void;
  onAudioDone(): void;
  onUserTranscript(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onError(code: ErrorCode, message: string): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
};

export function createSessionCore(opts: SessionCoreOptions): SessionCore {
  const log = opts.logger ?? consoleLogger;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  const idleMs = (() => {
    const raw = opts.agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    return raw === 0 || !Number.isFinite(raw) ? 0 : raw;
  })();

  let _reply: ReplyState = { currentReplyId: null, pendingTools: [], toolCallCount: 0 };
  let history: Message[] = [];
  let turnPromise: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  function resetIdle(): void {
    if (stopped || idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.info("session idle timeout", { sid: opts.id });
      opts.client.idleTimeout();
    }, idleMs);
  }

  function pushMessages(...msgs: Message[]): void {
    history.push(...msgs);
    if (maxHistory > 0 && history.length > maxHistory) {
      history.splice(0, history.length - maxHistory);
    }
  }

  function beginReply(replyId: string): void {
    _reply = { currentReplyId: replyId, pendingTools: [], toolCallCount: 0 };
    turnPromise = null;
  }

  function cancelReply(): void {
    _reply = { currentReplyId: null, pendingTools: [], toolCallCount: 0 };
  }

  return {
    id: opts.id,

    async start() {
      resetIdle();
      await opts.transport.start();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    // ─── Inbound from client ──────────────────────────────────────────────
    onAudio(bytes) {
      resetIdle();
      opts.transport.sendUserAudio(bytes);
    },
    onAudioReady() {
      // S2S greeting is automatic; pipeline transports may override via callbacks.
    },
    onCancel() {
      opts.transport.cancelReply();
      opts.client.cancelled();
    },
    onReset() {
      cancelReply();
      history = [];
      opts.client.reset();
    },
    onHistory(messages) {
      pushMessages(...messages);
    },

    // ─── Inbound from transport (stubbed; full impl in Task 8) ────────────
    onReplyStarted(replyId) {
      beginReply(replyId);
    },
    onReplyDone() {
      /* see Task 8 */
    },
    onCancelled() {
      cancelReply();
      opts.client.cancelled();
    },
    onAudioChunk(bytes) {
      opts.client.audio(bytes);
    },
    onAudioDone() {
      opts.client.audioDone();
    },
    onUserTranscript(text) {
      opts.client.userTranscript(text);
      pushMessages({ role: "user", content: text });
    },
    onAgentTranscript(text, interrupted) {
      opts.client.agentTranscript(text);
      if (!interrupted) pushMessages({ role: "assistant", content: text });
    },
    onToolCall(callId, name, args) {
      opts.client.toolCall(callId, name, args);
      // Full tool-execution wiring in Task 8.
    },
    onError(code, message) {
      opts.client.error(code, message);
    },
    onSpeechStarted() {
      opts.client.speechStarted();
    },
    onSpeechStopped() {
      opts.client.speechStopped();
    },
  };
}
