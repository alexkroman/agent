// Copyright 2026 the AAI authors. MIT license.
// S2S transport — wraps connectS2s and forwards typed callbacks into the SessionCore.

import { S2S_MAX_RESUME_ATTEMPTS } from "../../sdk/constants.ts";
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

/**
 * Configuration for {@link createS2sTransport}.
 * @internal
 */
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

/**
 * Create an S2S-mode Transport over a single AssemblyAI S2S WebSocket.
 * @internal
 */
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
  // Consecutive resume attempts with no real progress in between. Reset when a
  // resumed session actually does work (a reply starts); caps a server that
  // keeps accepting a resume then immediately dropping it (flapping loop).
  let resumeAttempts = 0;
  // Set by cancelReply(): AssemblyAI S2S has no cancel RPC, so audio for the
  // cancelled reply can still be on the wire after the client presses stop.
  // Drop those chunks until the next reply starts, or they resume playback of
  // the very reply the user interrupted.
  let suppressAudioUntilReply = false;
  // Latched once we surface a fatal connection error (failed/abandoned resume,
  // fatal close). The session is over; any trailing close from a dead socket
  // must not re-emit an error or start another resume loop.
  let sessionEnded = false;
  // Tool results that could not be delivered because the socket was down
  // (dropped mid-tool, awaiting resume). The provider restores the session
  // server-side with its tool calls still unanswered, so these must be
  // redelivered once the resumed socket is ready — silently dropping them
  // stalled the resumed turn until the idle timeout, with the only trace a
  // debug log line.
  let pendingToolResults: { callId: string; result: string }[] = [];
  // Aborted by stop() to abandon a handshake that has not completed yet — see
  // stop() and `ConnectS2sOptions.signal`.
  const teardown = new AbortController();

  /**
   * Redeliver tool results the dead socket dropped — the restored provider
   * session is still awaiting them. Runs on every session.ready; a no-op when
   * nothing was queued.
   */
  function flushPendingToolResults(): void {
    if (pendingToolResults.length === 0) return;
    const queued = pendingToolResults;
    pendingToolResults = [];
    for (const { callId, result } of queued) {
      log.info("S2S redelivering tool.result after resume", { sid: opts.sid, callId });
      if (handle?.sendToolResult(callId, result) !== true) {
        pendingToolResults.push({ callId, result });
      }
    }
  }

  /** Surface a fatal connection error exactly once and retire the session. */
  function endSession(detail: string): void {
    if (sessionEnded) return;
    sessionEnded = true;
    // Retiring the session must also DROP THE LINK. Most paths reach here from a
    // close, where the socket is already gone — but not all: when the service
    // rejects our `session.resume` with `session_not_found` it reports that IN
    // BAND and leaves the socket OPEN. The transport went on holding a live
    // (billed) provider session and relaying its frames — user transcripts,
    // replies, audio — to a client it had just told the call was over, i.e. one
    // that has released its microphone (aai-ui's `handleErrorEvent`). Found by
    // `integration/s2s-fuzz.integration.test.ts`, which reaches the ordering
    // only when the rejection lands before the resumed socket reports ready.
    //
    // Closing here is idempotent and cannot loop: the resulting close event hits
    // the `sessionEnded` guard at the top of handleClose. Queued tool results go
    // too — there is no longer any socket that could carry them.
    handle?.close();
    handle = null;
    pendingToolResults = [];
    opts.callbacks.onError("connection", detail);
  }

  /**
   * Gate an inbound provider event on the session still being live.
   *
   * Closing the socket in `endSession` is the fix; this is the rest of it.
   * `close()` asks the peer to hang up — it does not un-deliver what is already
   * buffered, so `ws` can still emit `message` events between the call and the
   * socket actually closing. Every one of those would be relayed to a client
   * that has been told the call is over and has released its microphone
   * (aai-ui's `handleErrorEvent`), which is the thing being fixed.
   *
   * `onClose`, `onError`, and `onSessionExpired` are deliberately NOT gated:
   * they carry their own latches, and onClose still has logging to do.
   */
  function whileLive<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      if (sessionEnded || closing) return;
      fn(...args);
    };
  }

  function buildCallbacks(): S2sCallbacks {
    return {
      onSessionReady: whileLive((id) => {
        const isFirstReady = providerSessionId === null;
        providerSessionId = id;
        if (reconnecting) {
          reconnecting = false;
          log.info("S2S resumed", { sid: opts.sid, sessionId: id });
        } else if (isFirstReady) {
          log.info("S2S session ready", { sid: opts.sid, sessionId: id });
        }
        flushPendingToolResults();
        opts.callbacks.onSessionReady?.(id);
      }),
      onReplyStarted: whileLive((replyId) => {
        // A reply on the (possibly resumed) socket is real progress — the
        // session is healthy again, so clear the flapping-resume counter.
        resumeAttempts = 0;
        suppressAudioUntilReply = false;
        currentReplyId = replyId;
        opts.callbacks.onReplyStarted(replyId);
      }),
      onReplyDone: whileLive(() => {
        currentReplyId = null;
        opts.callbacks.onReplyDone();
      }),
      onCancelled: whileLive(() => {
        currentReplyId = null;
        opts.callbacks.onCancelled();
      }),
      onAudio: whileLive((bytes: Uint8Array) => {
        if (suppressAudioUntilReply) return;
        opts.callbacks.onAudioChunk(bytes);
      }),
      onUserTranscript: whileLive((text: string) => opts.callbacks.onUserTranscript(text)),
      onUserTranscriptPartial: whileLive((text: string) =>
        opts.callbacks.onUserTranscriptPartial?.(text),
      ),
      onAgentTranscript: whileLive((text: string, interrupted: boolean) =>
        opts.callbacks.onAgentTranscript(text, interrupted),
      ),
      // `transcript.agent.delta` DOES arrive — re-measured against the live
      // service, see `_s2s-reply.ts`. It is the only carrier of text for a reply
      // that sends no final `transcript.agent`, which is the ordinary shape of a
      // tool-preamble turn.
      onAgentTranscriptPartial: whileLive((text: string) =>
        opts.callbacks.onAgentTranscriptPartial?.(text),
      ),
      onToolCall: whileLive((callId: string, name: string, args: Record<string, unknown>) =>
        opts.callbacks.onToolCall(callId, name, args),
      ),
      onSpeechStarted: whileLive(() => opts.callbacks.onSpeechStarted()),
      onSpeechStopped: whileLive(() => opts.callbacks.onSpeechStopped()),
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
      // An in-band service error is NOT the end of the session, and must not be
      // reported as one. Neither this path nor `connectS2s` closes the socket:
      // `session.error` with a non-expiry code (a rate limit, a rejected field)
      // and a bare `error` frame both leave the link up, and the conversation
      // demonstrably continues through them — the fuzz
      // (`integration/s2s-fuzz.integration.test.ts`) reaches `tool_call`,
      // `reply_done`, and audio afterwards on most seeds.
      //
      // `onError` defaults to fatal, and a fatal frame is not a banner: aai-ui's
      // `handleErrorEvent` calls `cleanupAudio()`, bumps the connection
      // generation, and sets `running: false` — so the microphone is RELEASED
      // while this transport goes on relaying replies to a client whose UI says
      // the call ended. A later event even recovers the state to "listening"
      // (`clearRecoveredError`), leaving a session that looks live and can never
      // hear the user again.
      //
      // Session death has exactly one reporter: `endSession`, driven by the
      // close and failed-resume paths, which are the only places that know the
      // link is gone. An error that really is terminal is followed by the
      // service closing the socket, so it still surfaces there — with the close
      // code attached, which is strictly more diagnostic than this frame.
      onError: (err) => opts.callbacks.onError("internal", err.message, { fatal: false }),
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
    endSession(detail);
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
      endSession(`S2S closed mid-reply (code=${code})`);
      return;
    }
    // An unexpected close with no reply in flight is NOT harmless: a
    // client-initiated close was already filtered out in handleClose (the
    // `closing` guard) and a session already declared dead is filtered by the
    // `sessionEnded` guard, so reaching here means the provider dropped a live
    // idle session. Staying silent left the client "connected" while every
    // later utterance vanished into a dead handle until the idle timeout.
    log.warn("S2S closed unexpectedly while idle", {
      sid: opts.sid,
      agent: opts.agent,
      code,
      reason,
    });
    endSession(`S2S closed unexpectedly (code=${code})`);
  }

  function startResume(prevId: string, code: number, reason: string): void {
    // Bound a flapping server that keeps accepting a resume then dropping it.
    // resumeAttempts resets on real progress (onReplyStarted), so a healthy
    // session that drops once always gets a fresh budget.
    if (resumeAttempts >= S2S_MAX_RESUME_ATTEMPTS) {
      log.warn("S2S giving up on resume — attempt cap reached", {
        sid: opts.sid,
        agent: opts.agent,
        attempts: resumeAttempts,
        code,
      });
      providerSessionId = null;
      endSession(`S2S resume abandoned after ${resumeAttempts} attempts (code=${code})`);
      return;
    }
    resumeAttempts++;
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
      // Throw-safe: the logger and onError sink are caller-injectable, and a
      // throw from this handler would itself be an unhandled rejection.
      try {
        const msg = errorMessage(err);
        log.warn("S2S resume failed", { sid: opts.sid, error: msg });
        failResume(`S2S resume failed: ${msg}`);
      } catch {
        // Nothing further to report the failure to.
      }
    });
  }

  function handleClose(code: number, reason: string): void {
    if (closing) {
      log.info("S2S closed", { code, reason });
      return;
    }
    if (sessionEnded) {
      // Trailing close from a socket whose session we already declared dead.
      log.info("S2S trailing close after session ended", { code, reason });
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

  async function connect(onReady: (h: S2sHandle) => void): Promise<void> {
    let newHandle: S2sHandle;
    try {
      newHandle = await _internals.connectS2s({
        apiKey: opts.apiKey,
        config: opts.s2sConfig,
        createWebSocket: createWs,
        logger: log,
        sid: opts.sid,
        callbacks: buildCallbacks(),
        signal: teardown.signal,
      });
    } catch (err) {
      // We abandoned this handshake ourselves in stop(); the client is gone, so
      // there is nothing to report and no session left to fail.
      if (closing) return;
      throw err;
    }
    // stop() may have run while the handshake was in flight (client
    // disconnected during connect). At that point `handle` was still null, so
    // stop()'s close() was a no-op — close the resolved socket now or it leaks
    // a live (billed) provider session. `sessionEnded` is the same situation
    // arrived at differently: the session was retired mid-handshake, so
    // installing this socket would resume a session already declared dead.
    if (closing || sessionEnded) {
      newHandle.close();
      return;
    }
    handle = newHandle;
    onReady(newHandle);
  }

  function resume(prevSessionId: string): Promise<void> {
    return connect((h) => h.resumeSession(prevSessionId));
  }

  function start(): Promise<void> {
    return connect((h) => h.updateSession(opts.sessionConfig));
  }

  async function stop(): Promise<void> {
    closing = true;
    // Abandons a handshake that has not completed yet. `handle?.close()` below
    // can only reach a socket that OPENED — a resume still waiting on its `open`
    // has produced no handle, and `ws` sets no handshakeTimeout, so without this
    // a client that hangs up mid-resume left a half-open (billed) provider
    // connection pinned for the life of the process. Found by
    // `integration/s2s-fuzz.integration.test.ts`, which shrank it to two
    // commands: session.ready, then a transient drop.
    teardown.abort();
    pendingToolResults = [];
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
      // During the resume window `handle` still points at the dead socket
      // (reassigned only when the replacement connects), so the send reports
      // failure; queue for redelivery once the resumed session is ready.
      const delivered = handle?.sendToolResult(callId, result) === true;
      if (!(delivered || closing || sessionEnded)) {
        log.info("S2S tool.result queued for redelivery", { sid: opts.sid, callId });
        pendingToolResults.push({ callId, result });
      }
    },
    cancelReply() {
      // AssemblyAI S2S doesn't expose an explicit cancel RPC — reply is
      // cancelled when the user speaks. Our `onCancel` from the client is a
      // best-effort signal, so drop any audio still arriving for the cancelled
      // reply until the next one starts; otherwise it resumes playback of the
      // reply the user just interrupted.
      currentReplyId = null;
      suppressAudioUntilReply = true;
    },
  };
}
