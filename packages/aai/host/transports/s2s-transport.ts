// Copyright 2026 the AAI authors. MIT license.
// S2S transport — wraps connectS2s and forwards typed callbacks into the SessionCore.

import type { Logger, S2SConfig } from "../runtime-config.ts";
import { consoleLogger } from "../runtime-config.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sCallbacks,
  type S2sHandle,
  type S2sSessionConfig,
  type S2sToolSchema,
} from "../s2s.ts";
import type { Transport, TransportCallbacks, TransportSessionConfig } from "./types.ts";

/** @internal Exposed for testing — allows spying on connectS2s in unit tests. */
export const _internals = { connectS2s };

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

/**
 * Close codes worth attempting `session.resume` on. These are network/server
 * blips, not protocol or auth violations. Per AssemblyAI's docs, sessions are
 * preserved for 30 s after disconnect, so resume is bounded by the window in
 * `RESUME_WINDOW_MS` below.
 */
const TRANSIENT_CLOSE_CODES = new Set<number>([
  1005, // No Status Received (abnormal close, no frame)
  1006, // Abnormal Closure (no close frame at all)
  1011, // Internal Server Error
  3005, // Session Cancelled (unknown server error)
]);

/**
 * AssemblyAI keeps the session alive for 30 s after disconnect; we leave a
 * little headroom so the resume request still fits inside that window after
 * the new WebSocket finishes opening.
 */
const RESUME_WINDOW_MS = 25_000;

export function createS2sTransport(opts: S2sTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  const createWs = opts.createWebSocket ?? defaultCreateS2sWebSocket;
  let handle: S2sHandle | null = null;
  let currentReplyId: string | null = null;
  /** Most recent `session.ready` ID — present once the upstream session is established. */
  let providerSessionId: string | null = null;
  /** When the current session became ready; bounds the resume window. */
  let sessionReadyAt = 0;
  /** Set by `stop()` so a deliberate close doesn't trigger a reconnect. */
  let closing = false;
  /**
   * True while a `session.resume` round-trip is in flight (between sending
   * resume and the next `session.ready`). Used to distinguish a resume failure
   * (close before ready) from a normal close.
   */
  let reconnecting = false;
  /**
   * Set when a reconnect attempt is kicked off, cleared once the resumed
   * session's `session.ready` arrives. Prevents back-to-back reconnect loops
   * when the freshly-resumed socket also drops before fully recovering.
   */
  let reconnectInFlight = false;

  function buildCallbacks(): S2sCallbacks {
    return {
      onSessionReady: (id) => {
        providerSessionId = id;
        sessionReadyAt = Date.now();
        if (reconnecting) {
          reconnecting = false;
          reconnectInFlight = false;
          log.info("S2S resumed", { sid: opts.sid, sessionId: id });
        }
        opts.callbacks.onSessionReady?.(id);
      },
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
        // The server told us the session no longer exists (most likely
        // session_not_found in response to our resume). Surface as fatal
        // rather than retrying — there's nothing left to resume.
        if (reconnecting) {
          reconnecting = false;
          reconnectInFlight = false;
          log.warn("S2S resume rejected: session expired", { sid: opts.sid });
          opts.callbacks.onError("connection", "S2S resume failed: session expired");
          return;
        }
        log.info("S2S session expired", { sid: opts.sid });
        handle?.close();
      },
      onError: (err) => opts.callbacks.onError("internal", err.message),
      onClose: (code, reason) => handleClose(code, reason),
    };
  }

  function canResumeAfter(code: number): boolean {
    if (!TRANSIENT_CLOSE_CODES.has(code)) return false;
    if (providerSessionId === null) return false;
    if (reconnectInFlight) return false;
    return sessionReadyAt > 0 && Date.now() - sessionReadyAt < RESUME_WINDOW_MS;
  }

  function emitFatalClose(code: number, reason: string, wasReconnecting: boolean): void {
    if (wasReconnecting) {
      // Fresh resume socket closed before session.ready — resume failed.
      reconnecting = false;
      reconnectInFlight = false;
      opts.callbacks.onError("connection", `S2S resume failed (code=${code})`);
      return;
    }
    if (currentReplyId !== null) {
      log.warn("S2S closed with active reply", {
        sid: opts.sid,
        agent: opts.agent,
        activeReplyId: currentReplyId,
        code,
        reason,
      });
      opts.callbacks.onError("connection", `S2S closed mid-reply (code=${code})`);
      return;
    }
    log.info("S2S closed", { code, reason });
  }

  function startResume(prevId: string, code: number, reason: string): void {
    reconnectInFlight = true;
    reconnecting = true;
    log.warn("S2S unexpected close — attempting resume", {
      sid: opts.sid,
      agent: opts.agent,
      code,
      reason,
      prevSessionId: prevId,
    });
    // The in-flight reply is gone; unblock SessionCore's turn promise.
    if (currentReplyId !== null) {
      currentReplyId = null;
      opts.callbacks.onCancelled();
    }
    void resume(prevId).catch((err: unknown) => {
      reconnecting = false;
      reconnectInFlight = false;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("S2S resume failed", { sid: opts.sid, error: msg });
      opts.callbacks.onError("connection", `S2S resume failed: ${msg}`);
    });
  }

  function handleClose(code: number, reason: string): void {
    if (closing) {
      log.info("S2S closed", { code, reason });
      return;
    }
    const wasReconnecting = reconnecting;
    if (!canResumeAfter(code)) {
      emitFatalClose(code, reason, wasReconnecting);
      return;
    }
    // canResumeAfter ensures providerSessionId !== null; capture as const.
    const prevId = providerSessionId;
    if (prevId === null) return;
    startResume(prevId, code, reason);
  }

  async function resume(prevSessionId: string): Promise<void> {
    const newHandle = await _internals.connectS2s({
      apiKey: opts.apiKey,
      config: opts.s2sConfig,
      createWebSocket: createWs,
      logger: log,
      ...(opts.sid !== undefined ? { sid: opts.sid } : {}),
      callbacks: buildCallbacks(),
    });
    if (closing) {
      newHandle.close();
      return;
    }
    handle = newHandle;
    newHandle.resumeSession(prevSessionId);
  }

  async function start(): Promise<void> {
    handle = await _internals.connectS2s({
      apiKey: opts.apiKey,
      config: opts.s2sConfig,
      createWebSocket: createWs,
      logger: log,
      sid: opts.sid,
      callbacks: buildCallbacks(),
    });
    handle.updateSession(opts.sessionConfig);
  }

  async function stop(): Promise<void> {
    closing = true;
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
