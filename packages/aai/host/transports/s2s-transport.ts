// Copyright 2026 the AAI authors. MIT license.
// S2S transport — wraps connectS2s and forwards typed callbacks into the SessionCore.

import { errorMessage } from "../../sdk/utils.ts";
import type { Logger, S2SConfig } from "../runtime-config.ts";
import { consoleLogger } from "../runtime-config.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sCallbacks,
  type S2sHandle,
  type S2sSessionConfig,
} from "../s2s.ts";
import type { Transport, TransportCallbacks } from "./types.ts";

/** @internal Exposed for testing — allows spying on connectS2s in unit tests. */
export const _internals = { connectS2s };

export type S2sTransportOptions = {
  apiKey: string;
  s2sConfig: S2SConfig;
  sessionConfig: S2sSessionConfig;
  callbacks: TransportCallbacks;
  sid: string;
  agent: string;
  createWebSocket?: CreateS2sWebSocket;
  logger?: Logger;
};

/**
 * Close codes worth attempting `session.resume` on. These are network/server
 * blips, not protocol or auth violations. AssemblyAI keeps the session
 * available for 30 s after disconnect; reconnect runs immediately on close,
 * so the resume request reliably lands inside that window.
 */
const TRANSIENT_CLOSE_CODES = new Set<number>([
  1005, // No Status Received (abnormal close, no frame)
  1006, // Abnormal Closure (no close frame at all)
  1011, // Internal Server Error
  3005, // Session Cancelled (unknown server error)
]);

export function createS2sTransport(opts: S2sTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  const createWs = opts.createWebSocket ?? defaultCreateS2sWebSocket;
  let handle: S2sHandle | null = null;
  let currentReplyId: string | null = null;
  let providerSessionId: string | null = null;
  let closing = false;
  // True between sending `session.resume` and the next `session.ready`.
  // Distinguishes a resume failure (close before ready) from a normal close
  // and prevents back-to-back reconnect loops if the resumed socket also drops.
  let reconnecting = false;

  function buildCallbacks(): S2sCallbacks {
    return {
      onSessionReady: (id) => {
        const isFirstReady = providerSessionId === null;
        providerSessionId = id;
        if (reconnecting) {
          reconnecting = false;
          log.info("S2S resumed", { sid: opts.sid, sessionId: id });
        } else if (isFirstReady) {
          log.info("S2S session ready", { sid: opts.sid, sessionId: id });
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
        // Server reports session no longer exists (likely session_not_found
        // in response to our resume). Surface as fatal — nothing to resume.
        if (reconnecting) {
          log.warn("S2S resume rejected: session expired", { sid: opts.sid });
          failResume("S2S resume failed: session expired");
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
    return TRANSIENT_CLOSE_CODES.has(code) && providerSessionId !== null && !reconnecting;
  }

  /**
   * Report a failed resume exactly once. A failed resume attempt surfaces
   * through up to two paths — the resume socket's `close` event and the
   * rejected `connectS2s` promise — in either order depending on how the
   * socket died; the `reconnecting` guard makes whichever lands first the
   * only one that emits. Clearing `providerSessionId` retires the session
   * (single resume attempt), so a trailing transient `close` can't loop
   * back into `startResume`.
   */
  function failResume(detail: string): void {
    if (!reconnecting) return;
    reconnecting = false;
    providerSessionId = null;
    opts.callbacks.onError("connection", detail);
  }

  function emitFatalClose(code: number, reason: string, wasReconnecting: boolean): void {
    if (wasReconnecting) {
      // Fresh resume socket closed before session.ready — resume failed.
      failResume(`S2S resume failed (code=${code})`);
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
      const msg = errorMessage(err);
      log.warn("S2S resume failed", { sid: opts.sid, error: msg });
      failResume(`S2S resume failed: ${msg}`);
    });
  }

  function handleClose(code: number, reason: string): void {
    if (closing) {
      log.info("S2S closed", { code, reason });
      return;
    }
    const wasReconnecting = reconnecting;
    const prevId = providerSessionId;
    if (!canResumeAfter(code) || prevId === null) {
      emitFatalClose(code, reason, wasReconnecting);
      return;
    }
    startResume(prevId, code, reason);
  }

  async function resume(prevSessionId: string): Promise<void> {
    const newHandle = await _internals.connectS2s({
      apiKey: opts.apiKey,
      config: opts.s2sConfig,
      createWebSocket: createWs,
      logger: log,
      sid: opts.sid,
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
    const newHandle = await _internals.connectS2s({
      apiKey: opts.apiKey,
      config: opts.s2sConfig,
      createWebSocket: createWs,
      logger: log,
      sid: opts.sid,
      callbacks: buildCallbacks(),
    });
    // stop() may have run while the handshake was in flight (client
    // disconnected during connect). At that point `handle` was still null, so
    // stop()'s close() was a no-op — close the resolved socket now or it leaks
    // a live (billed) provider session. Mirrors resume().
    if (closing) {
      newHandle.close();
      return;
    }
    handle = newHandle;
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
  };
}
