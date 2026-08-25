// Copyright 2026 the AAI authors. MIT license.
// S2S transport — wraps connectS2s and forwards typed callbacks into the SessionCore.

import { errorMessage } from "@alexkroman1/aai/utils";
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
import { createEmitError } from "./pipeline-error.ts";
import { createS2sLifecycle } from "./s2s-lifecycle.ts";
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
  // One reporter for both arms of the decision this transport keeps making —
  // omitting `fatal` says the session is OVER, and that spelling lives in
  // exactly one place (pipeline-error.ts) for all three transports.
  const emitError = createEmitError(opts.callbacks);
  let handle: S2sHandle | null = null;
  let currentReplyId: string | null = null;
  // Set by cancelReply(): AssemblyAI S2S has no cancel RPC, so audio for the
  // cancelled reply can still be on the wire after the client presses stop.
  // Drop those chunks until the next reply starts, or they resume playback of
  // the very reply the user interrupted.
  let suppressAudioUntilReply = false;
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
   * Where this connection is — `connecting`, `live`, `resuming`, `ended`,
   * `closed` — and every rule about which of those may become which.
   *
   * This replaced `closing`, `sessionEnded`, `reconnecting` and
   * `resumeAttempts`, along with the dedup each of them doubled as. See
   * `s2s-lifecycle.ts`; the effects below are the transport's half.
   */
  /**
   * Close and forget the link, absorbing a `close()` that throws.
   *
   * Best-effort by nature — the socket is already gone on almost every path
   * here — and best-effort is also REQUIRED, because both callers run inside a
   * lifecycle action: XState catches what an action throws, puts the actor into
   * `status: "error"`, and every later event is then ignored. So a throwing
   * `close()` would not merely fail to close, it would silently retire the
   * machine that decides whether inbound frames may still reach the client.
   * `stop()` is the one place a close failure must propagate, and it does its
   * own — outside the machine, for exactly this reason.
   */
  function closeQuietly(): void {
    const dying = handle;
    handle = null;
    try {
      dying?.close();
    } catch (err) {
      log.warn("S2S close failed", { sid: opts.sid, error: errorMessage(err) });
    }
  }

  const lifecycle = createS2sLifecycle({
    resume: (sessionId: string) => resume(sessionId),
    dropLink(): void {
      // Retiring the session must also DROP THE LINK. Most paths reach here
      // from a close, where the socket is already gone — but not all: when the
      // service rejects our `session.resume` with `session_not_found` it
      // reports that IN BAND and leaves the socket OPEN. The transport went on
      // holding a live (billed) provider session and relaying its frames — user
      // transcripts, replies, audio — to a client it had just told the call was
      // over, i.e. one that has released its microphone (aai-ui's
      // `handleErrorEvent`). Found by
      // `integration/s2s-fuzz.integration.test.ts`, which reaches the ordering
      // only when the rejection lands before the resumed socket reports ready.
      //
      // Closing here cannot loop: the resulting close event arrives in `ended`,
      // which only logs it. Queued tool results go too — there is no longer any
      // socket that could carry them.
      closeQuietly();
      pendingToolResults = [];
    },
    closeHandle: closeQuietly,
    // No `fatal` key: this is the one path that really ends an S2S session.
    reportFatal: (detail: string) => emitError("connection", detail),
    cancelInFlightReply(): void {
      if (currentReplyId === null) return;
      currentReplyId = null;
      opts.callbacks.report({ type: "reply.cancelled" });
    },
    flushPendingToolResults,
    currentReplyId: () => currentReplyId,
    log: (level, message, fields) =>
      log[level](message, { sid: opts.sid, agent: opts.agent, ...fields }),
  });

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

  /**
   * Gate an inbound provider event on the session still being live.
   *
   * Closing the socket in the lifecycle's `dropLink` is the fix; this is the
   * rest of it. `close()` asks the peer to hang up — it does not un-deliver
   * what is already buffered, so `ws` can still emit `message` events between
   * the call and the socket actually closing. Every one of those would be
   * relayed to a client that has been told the call is over and has released
   * its microphone (aai-ui's `handleErrorEvent`), which is the thing being
   * fixed.
   */
  function whileLive<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      if (!lifecycle.acceptsInbound()) return;
      fn(...args);
    };
  }

  /**
   * Gate a whole group of inbound callbacks, so gating is the DEFAULT.
   *
   * Applied by hand this was twelve `whileLive(...)` wrappers and a comment
   * naming the three exemptions — an arrangement where the thirteenth callback
   * is ungated by omission and nothing says so. Here the exemptions are the
   * ones that do not go through this function, which is a fact about the code
   * rather than a note beside it.
   */
  function gateInbound<T extends Record<string, (...args: never[]) => void>>(raw: T): T {
    const gated: Record<string, (...args: never[]) => void> = {};
    for (const [name, fn] of Object.entries(raw)) gated[name] = whileLive(fn);
    return gated as T;
  }

  function buildCallbacks(): S2sCallbacks {
    return {
      // NOT gated, deliberately, and the only three: they DRIVE the phase the
      // gate reads, so gating them on it would be circular — a close could
      // never retire a session, because retirement is what the gate consults.
      // What "in a resume, or not" means to each is the lifecycle's business.
      onSessionExpired: () => lifecycle.send({ type: "EXPIRED" }),
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
      // Session death has exactly one reporter: the lifecycle's `reportFatal`,
      // driven by the close and failed-resume paths, which are the only places
      // that know the link is gone. An error that really is terminal is
      // followed by the service closing the socket, so it still surfaces there
      // — with the close code attached, which is strictly more diagnostic than
      // this frame.
      onError: (err) => emitError("internal", err.message, { fatal: false }),
      onClose: (code, reason) => handleClose(code, reason),
      ...gateInbound({
        // Which log line this deserves — first ready, a resume, or a rename —
        // is a question about the phase, so the lifecycle answers it and owns
        // the flush and the notify that follow.
        onSessionReady: (id: string) => lifecycle.send({ type: "READY", sessionId: id }),
        onReplyStarted: (replyId: string) => {
          // A reply on the (possibly resumed) socket is real progress — the
          // session is healthy again, so clear the flapping-resume counter.
          lifecycle.send({ type: "PROGRESS" });
          suppressAudioUntilReply = false;
          currentReplyId = replyId;
          opts.callbacks.onReplyStarted(replyId);
        },
        onReplyDone: () => {
          currentReplyId = null;
          opts.callbacks.report({ type: "reply.completed" });
        },
        onCancelled: () => {
          currentReplyId = null;
          opts.callbacks.report({ type: "reply.cancelled" });
        },
        onAudio: (bytes: Uint8Array) => {
          if (suppressAudioUntilReply) return;
          opts.callbacks.onAudioChunk(bytes);
        },
        onUserTranscript: (text: string) =>
          opts.callbacks.report({ type: "user-transcript.committed", text }),
        onUserTranscriptPartial: (text: string) =>
          opts.callbacks.report({ type: "user-transcript.updated", text }),
        // An INTERRUPTED reply is `.updated`, never `.committed`: it enters no
        // history, because history records what the caller HEARD and the service
        // trims an interrupted transcript to what was spoken. This is the one call
        // site in the repo that reports either arm — every pipeline path records.
        onAgentTranscript: (text: string, interrupted: boolean) =>
          opts.callbacks.report({
            type: interrupted ? "agent-transcript.updated" : "agent-transcript.committed",
            text,
          }),
        // `transcript.agent.delta` DOES arrive — re-measured against the live
        // service, see `_s2s-reply.ts`. It is the only carrier of text for a reply
        // that sends no final `transcript.agent`, which is the ordinary shape of a
        // tool-preamble turn.
        onAgentTranscriptPartial: (text: string) =>
          opts.callbacks.report({ type: "agent-transcript.updated", text }),
        onToolCall: (callId: string, name: string, args: Record<string, unknown>) =>
          opts.callbacks.report({ type: "tool.called", toolCallId: callId, toolName: name, args }),
        onSpeechStarted: () => opts.callbacks.report({ type: "speech.started" }),
        onSpeechStopped: () => opts.callbacks.report({ type: "speech.stopped" }),
      }),
    };
  }

  /**
   * Handle the close by handing the lifecycle the ONE fact it cannot read off a
   * phase: whether this close code is a network blip or a protocol verdict.
   *
   * Everything the four latches used to decide here — is this our own hang-up,
   * a trailing close from a session already retired, a failed resume, a
   * resumable drop, or the end — is now which phase the `CLOSED` event arrives
   * in. See `s2s-lifecycle.ts`.
   */
  function handleClose(code: number, reason: string): void {
    lifecycle.send({ type: "CLOSED", code, reason, transient: TRANSIENT_CLOSE_CODES.has(code) });
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
      // there is nothing to report and no session left to fail. A rejection in
      // any other phase is the caller's to see: on the resume path it is the
      // invoked actor's failure (see `s2s-lifecycle.ts`), and on the first
      // handshake it rejects `start()`.
      if (lifecycle.phase() === "closed") return;
      throw err;
    }
    // The phase may have moved while the handshake was in flight — a client
    // disconnect, or a session retired mid-handshake. `handle` was still null
    // then, so the teardown's close() was a no-op; close the resolved socket
    // now or it leaks a live (billed) provider session. This check survives the
    // move to a statechart because the socket is opened by a PROMISE the
    // machine does not own: stopping the invoked actor cannot un-resolve it.
    if (!lifecycle.acceptsInbound()) {
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
    // The phase first: entering `closed` stops any resume actor in flight,
    // which is the half that used to be missing — the `closing` latch could be
    // set while `reconnecting` was still true.
    lifecycle.send({ type: "STOP" });
    // Then the teardown, HERE rather than as the machine's entry action: XState
    // turns what an action throws into an actor error, and a throwing
    // `handle.close()` has to reach the caller — the runtime's shutdown warning
    // is the only thing that tells an operator a provider link leaked.
    //
    // `teardown.abort()` abandons a handshake that has not completed yet.
    // `handle?.close()` can only reach a socket that OPENED — a resume still
    // waiting on its `open` has produced no handle, and `ws` sets no
    // handshakeTimeout, so without the abort a client that hangs up mid-resume
    // left a half-open (billed) provider connection pinned for the life of the
    // process. Found by `integration/s2s-fuzz.integration.test.ts`, which
    // shrank it to two commands: session.ready, then a transient drop.
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
      if (!delivered && lifecycle.acceptsInbound()) {
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
