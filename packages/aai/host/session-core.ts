// Copyright 2026 the AAI authors. MIT license.
// Unified session — owns reply lifecycle, conversation history, idle timeout,
// and tool-step enforcement. Replaces session.ts + pipeline-session.ts.

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_HISTORY,
  FILE_UPLOAD_CHUNK_BYTES,
  MAX_SYNC_AUDIO_BYTES,
} from "../sdk/constants.ts";
import type { ClientEvent, ClientSink, SessionErrorCode } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import { capToolResult, errorMessage, toolError } from "../sdk/utils.ts";
import { withTrailingSilence } from "./_pcm.ts";
import { createCoalescingTimer } from "./_timer.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { Transport } from "./transports/types.ts";

const REPLY_DONE_SLOW_THRESHOLD_MS = 50;

type PendingTool = { callId: string; result: string };

type ReplyState = {
  currentReplyId: string | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
  /** Aborts this reply's in-flight tool executions on barge-in/reset/stop. */
  abort: AbortController;
  /**
   * True after a `reply.done` flushed this reply's tool results to the
   * transport and the turn is waiting on the provider's continuation.
   * Cleared by any sign of continuation progress (tool call, transcript,
   * audio). While set, a `reply.done` with no new pending tools is a
   * duplicate frame — flushing it would emit a premature client
   * `reply_done`/`audio_done` mid-turn.
   */
  flushedAwaitingContinuation: boolean;
};

export type SessionCoreOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  transport: Transport;
  logger?: Logger;
  /**
   * Host/relay mode hook. When set, tool calls are relayed to the client for
   * out-of-process execution: `onToolCall` skips its own `tool_call` emit (the
   * relay `executeTool` emits it, keyed by `toolCallId`) and inbound
   * `tool_result` frames are routed here to settle the pending call.
   */
  onToolResult?: (msg: { toolCallId: string; result: string; error?: string }) => void;
};

export type SessionCore = {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Inbound from client (decoded by ws-handler)
  onAudio(bytes: Uint8Array): void;
  onAudioReady(): void;
  /** Begin buffering binary frames as one uploaded clip (see `transcribe_file_start`). */
  onTranscribeFileStart(sampleRate: number, byteLength: number): void;
  /** Finish the upload: transcribe the buffered clip in one shot (or replay it). */
  onTranscribeFileEnd(): void;
  onCancel(): void;
  onReset(): void;
  onHistory(messages: readonly Message[]): void;
  /** Inbound relayed tool result (host mode): settles the pending relay call. */
  onToolResult(toolCallId: string, result: string, error?: string): void;
  // Inbound from transport (spec §4.2)
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudioChunk(bytes: Uint8Array): void;
  onAudioDone(): void;
  onUserTranscript(text: string): void;
  /** Interim user transcript — forwarded to the client, never added to history. */
  onUserTranscriptPartial(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onError(code: SessionErrorCode, message: string, opts?: { fatal?: boolean }): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
};

export function createSessionCore(opts: SessionCoreOptions): SessionCore {
  const log = opts.logger ?? consoleLogger;
  const rawIdleMs = opts.agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleMs = rawIdleMs === 0 || !Number.isFinite(rawIdleMs) ? 0 : rawIdleMs;

  function emptyReply(): ReplyState {
    return {
      currentReplyId: null,
      pendingTools: [],
      toolCallCount: 0,
      abort: new AbortController(),
      flushedAwaitingContinuation: false,
    };
  }

  let reply: ReplyState = emptyReply();
  let history: Message[] = [];
  let turnPromise: Promise<void> | null = null;
  let stopped = false;
  /** In-flight file upload (between transcribe_file_start and _end): binary
   *  frames land here instead of streaming to the transport as mic audio.
   *  Preallocated to the declared (cap-validated) byteLength; `received`
   *  tracks the fill so the per-frame append stays O(frame). */
  let fileUpload: { sampleRate: number; buffer: Uint8Array; received: number } | null = null;

  /** Hand the buffered clip to the transport (idempotent — see onAudio). */
  function finishFileUpload(): void {
    const upload = fileUpload;
    fileUpload = null;
    if (!upload || upload.received === 0) return;
    const pcm = upload.buffer.subarray(0, upload.received);
    if (opts.transport.transcribeFile) {
      opts.transport.transcribeFile(pcm, upload.sampleRate);
      return;
    }
    // No one-shot path on this transport (e.g. S2S): replay the clip
    // through the realtime audio path in socket-friendly chunks, padded
    // with silence so endpointing commits the final turn (the client
    // skips padding on this path).
    const padded = withTrailingSilence(pcm, upload.sampleRate);
    void replayClipThroughRealtime(padded);
  }

  /**
   * Replay a padded clip through the realtime audio path, yielding between
   * chunks. A synchronous blast never lets the provider socket flush, so its
   * send buffer grows past the audio gate's cap (~1 MiB ≈ 25 s of PCM16) and
   * every later chunk — including the trailing endpointing silence, so the
   * turn may never commit — is silently dropped. Yielding lets the socket
   * drain and keeps the buffered amount under the gate threshold.
   */
  async function replayClipThroughRealtime(padded: Uint8Array): Promise<void> {
    for (let i = 0; i < padded.byteLength; i += FILE_UPLOAD_CHUNK_BYTES) {
      if (stopped) return;
      opts.transport.sendUserAudio(padded.subarray(i, i + FILE_UPLOAD_CHUNK_BYTES));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function emit(event: ClientEvent): void {
    opts.client.event(event);
  }

  // Re-armed at audio-frame rate, so the coalescing timer matters: it records
  // the deadline and keeps one long-lived timer instead of re-arming a
  // 5-minute timeout on every chunk. (Its clear() also zeroes the deadline,
  // so a callback that already fired when stop() ran cannot re-arm and pin
  // the session for another idleMs.)
  const idleTimer = createCoalescingTimer(() => {
    log.info("session idle timeout", { sid: opts.id });
    emit({ type: "idle_timeout" });
  });

  function resetIdle(): void {
    if (stopped || idleMs <= 0) return;
    idleTimer.arm(idleMs);
  }

  function pushMessages(...msgs: Message[]): void {
    history.push(...msgs);
    if (history.length > DEFAULT_MAX_HISTORY) {
      history.splice(0, history.length - DEFAULT_MAX_HISTORY);
    }
  }

  function beginReply(replyId: string): void {
    // Tools still in flight belong to the reply being replaced — they're
    // orphaned either way, so cancel them instead of letting them run on.
    reply.abort.abort();
    reply = { ...emptyReply(), currentReplyId: replyId };
    turnPromise = null;
  }

  function cancelReply(): void {
    reply.abort.abort();
    reply = emptyReply();
  }

  function flushReply(startMs: number, hadTurnPromise: boolean): void {
    const stepsUsed = reply.toolCallCount;
    if (stepsUsed > 0) log.info("Turn complete", { steps: stepsUsed, agent: opts.agent });
    opts.client.playAudioDone();
    emit({ type: "reply_done" });
    reply.currentReplyId = null;
    const durationMs = Date.now() - startMs;
    if (durationMs >= REPLY_DONE_SLOW_THRESHOLD_MS) {
      log.warn("slow reply_done dispatch", {
        sid: opts.id,
        agent: opts.agent,
        durationMs,
        hadTurnPromise,
      });
    }
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
      idleTimer.clear();
      // Cancel in-flight tools so the drain below settles promptly instead
      // of holding the session (and provider sockets) open for up to the
      // full tool timeout after a disconnect.
      reply.abort.abort();
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    // ─── Inbound from client ──────────────────────────────────────────────
    onAudio(bytes) {
      resetIdle();
      if (fileUpload) {
        // Mid-upload: this frame is part of the clip, not live mic audio.
        // Frames beyond the declared byteLength are dropped rather than
        // buffered — the declaration was validated against the cap.
        if (fileUpload.received + bytes.byteLength <= fileUpload.buffer.byteLength) {
          fileUpload.buffer.set(bytes, fileUpload.received);
          fileUpload.received += bytes.byteLength;
          // The declaration is fulfilled — finalize now rather than waiting
          // on `transcribe_file_end` (which then no-ops). A dropped end
          // frame must not leave the session absorbing mic audio forever.
          if (fileUpload.received === fileUpload.buffer.byteLength) finishFileUpload();
        } else {
          log.warn("transcribe_file: dropping bytes past declared byteLength", { sid: opts.id });
        }
        return;
      }
      opts.transport.sendUserAudio(bytes);
    },
    onTranscribeFileStart(sampleRate, byteLength) {
      resetIdle();
      // Defense in depth: ws-handler's schema already caps byteLength, but
      // this is a public entry point — the client-supplied length sizes the
      // allocation below, so re-validate before trusting it.
      if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > MAX_SYNC_AUDIO_BYTES) {
        log.warn("transcribe_file_start: invalid byteLength; ignoring", {
          sid: opts.id,
          byteLength,
        });
        return;
      }
      // A new upload replaces any half-finished one (client retry).
      fileUpload = { sampleRate, buffer: new Uint8Array(byteLength), received: 0 };
    },
    onTranscribeFileEnd() {
      resetIdle();
      finishFileUpload();
    },
    onAudioReady() {
      // Intentionally inert, and there is no override mechanism: greeting
      // dispatch is the transport's own business. S2S greets automatically, and
      // the pipeline transport has an internal `onAudioReady` fired by
      // pipeline-providers.ts when the provider sockets open — unrelated to
      // this client frame. The frame is accepted (clients send it) and ignored;
      // `TransportCallbacks` deliberately has no member for it.
    },
    onCancel() {
      opts.transport.cancelReply();
      emit({ type: "cancelled" });
    },
    onReset() {
      cancelReply();
      fileUpload = null;
      history = [];
      // Clear conversation state the transport owns (pipeline LLM history);
      // without this the "forgotten" dialogue keeps feeding the next turn.
      opts.transport.reset?.();
      emit({ type: "reset" });
    },
    onHistory(messages) {
      pushMessages(...messages);
      // Forward to the transport so pipeline mode's LLM sees the restored
      // context on reconnect (S2S restores context service-side via resume).
      opts.transport.seedHistory?.(messages);
    },
    onToolResult(toolCallId, result, error) {
      opts.onToolResult?.({ toolCallId, result, ...(error !== undefined ? { error } : {}) });
    },

    // ─── Inbound from transport ───────────────────────────────────────────
    onReplyStarted(replyId) {
      beginReply(replyId);
    },

    onReplyDone() {
      const startMs = Date.now();
      // Capture the reply object, not just its id: barge-in/reset swap in a
      // fresh reply object (beginReply/cancelReply), and sendPending runs later
      // (after turnPromise). Comparing by identity keeps a stale reply.done
      // from mutating the current reply.
      const doneReply = reply;
      // Dedup duplicate reply.done events — once the reply is fully dispatched
      // (or was never started) currentReplyId is null.
      if (doneReply.currentReplyId === null) {
        log.debug("Dropping duplicate reply.done (no active reply)");
        return;
      }
      const hadTurnPromise = turnPromise !== null;
      const sendPending = () => {
        // A newer reply replaced this one → it's stale. Drop its orphaned
        // pending tools; never touch the current reply.
        if (reply !== doneReply) {
          doneReply.pendingTools = [];
          return;
        }
        if (doneReply.pendingTools.length > 0) {
          for (const tool of doneReply.pendingTools)
            opts.transport.sendToolResult(tool.callId, tool.result);
          doneReply.pendingTools = [];
          doneReply.flushedAwaitingContinuation = true;
        } else if (doneReply.flushedAwaitingContinuation) {
          // Tool results were already flushed and no continuation progress
          // (tool call / transcript / audio) has arrived since — this
          // reply.done is a duplicate frame, not the turn's real end.
          log.debug("Dropping duplicate reply.done (awaiting tool continuation)");
        } else {
          flushReply(startMs, hadTurnPromise);
        }
      };
      // sendPending writes to the transport, which may be a dying socket — a
      // throw here must surface as a log, not an unhandled rejection (or a
      // sync throw out of the transport's event dispatch).
      const sendPendingSafely = () => {
        try {
          sendPending();
        } catch (err) {
          log.warn("reply.done dispatch failed", { sid: opts.id, error: errorMessage(err) });
        }
      };
      if (hadTurnPromise) {
        void turnPromise?.then(sendPendingSafely).catch((err: unknown) => {
          log.warn("turn promise rejected before reply.done dispatch", {
            sid: opts.id,
            error: errorMessage(err),
          });
        });
      } else sendPendingSafely();
    },

    onCancelled() {
      cancelReply();
      emit({ type: "cancelled" });
    },

    onAudioChunk(bytes) {
      reply.flushedAwaitingContinuation = false;
      opts.client.playAudioChunk(bytes);
    },
    onAudioDone() {
      opts.client.playAudioDone();
    },

    onUserTranscript(text) {
      emit({ type: "user_transcript", text });
      pushMessages({ role: "user", content: text });
    },
    onUserTranscriptPartial(text) {
      emit({ type: "user_transcript_partial", text });
    },
    onAgentTranscript(text, interrupted) {
      reply.flushedAwaitingContinuation = false;
      emit({ type: "agent_transcript", text });
      if (!interrupted) pushMessages({ role: "assistant", content: text });
    },

    onToolCall(callId, name, args) {
      // In relay/host mode the relay `executeTool` emits the `tool_call` frame
      // itself (keyed by callId), so emitting here too would duplicate it.
      if (!opts.onToolResult) emit({ type: "tool_call", toolCallId: callId, toolName: name, args });
      if (reply.currentReplyId === null) {
        log.warn("tool_call with no active reply", { sid: opts.id, name });
        return;
      }
      // Bind results to the reply that issued the call. If a barge-in/reset
      // swaps in a new reply before this tool completes, the result lands in
      // this (now orphaned) object instead of corrupting the new reply's
      // pendingTools (which would hang or mis-route the turn).
      const activeReply = reply;
      activeReply.flushedAwaitingContinuation = false;
      activeReply.toolCallCount++;
      const maxSteps = opts.agentConfig.maxSteps;
      if (maxSteps !== undefined && activeReply.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded; refusing tool call", {
          toolCallCount: activeReply.toolCallCount,
          maxSteps,
        });
        activeReply.pendingTools.push({
          callId,
          result: toolError("Maximum tool steps reached. Please respond to the user now."),
        });
        emit({ type: "tool_call_done", toolCallId: callId, result: "{}" });
        return;
      }
      const p = (async () => {
        try {
          // Snapshot history: the live array is push/spliced by transcript
          // events while the tool runs (mirrors to-vercel-tools.ts). The
          // reply's abort signal lets barge-in/reset/stop settle the call.
          const result = await opts.executeTool(name, args, opts.id, history.slice(), {
            toolCallId: callId,
            signal: activeReply.abort.signal,
          });
          // Full result goes to the provider; the client `tool_call_done`
          // event is capped by the wire schema (MAX_TOOL_RESULT_CHARS), so
          // truncate it or the client silently drops the whole message and the
          // UI tool-call block stays "pending" forever.
          activeReply.pendingTools.push({ callId, result });
          emit({ type: "tool_call_done", toolCallId: callId, result: capToolResult(result) });
        } catch (err) {
          const message = errorMessage(err);
          activeReply.pendingTools.push({ callId, result: toolError(message) });
          emit({ type: "tool_call_done", toolCallId: callId, result: capToolResult(message) });
        }
      })();
      turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
    },

    onError(code, message, errOpts) {
      emit({ type: "error", code, message, ...(errOpts?.fatal === false && { fatal: false }) });
    },
    onSpeechStarted() {
      emit({ type: "speech_started" });
    },
    onSpeechStopped() {
      emit({ type: "speech_stopped" });
    },
  };
}
