// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 */

import {
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  LOG_PREVIEW_CHARS,
  WS_NORMAL_CLOSURE,
  WS_OPEN,
} from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { errorMessage, isRecord, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import { createAudioSendGate } from "./_audio-gate.ts";
import { base64ToUint8, uint8ToBase64 } from "./_base64.ts";
import {
  type DispatchContext,
  type DispatchState,
  dispatchS2sMessage,
  type S2sCallbacks,
} from "./_s2s-dispatch.ts";
import { parseS2sMessage } from "./_s2s-messages.ts";
import { countReplyAudio, createReplyAudit } from "./_s2s-reply.ts";
import {
  type CreateHeaderWebSocket,
  createWsOpenRace,
  defaultCreateHeaderWebSocket,
  type HeaderWebSocket,
} from "./_ws.ts";
import type { Logger, S2sConfig } from "./runtime-config.ts";
import { consoleLogger, debugLoggingEnabled } from "./runtime-config.ts";

/**
 * One `session.update` audio-format block. `audio/pcm` is this service's own
 * encoding name, NOT the protocol's client-facing `pcm16` (`sdk/protocol.ts`).
 */
const pcmAudio = (sample_rate: number) => ({
  type: "audio",
  format: { encoding: "audio/pcm", sample_rate },
});

/**
 * Voice-focus block for the S2S `input`, pinned to the SAME numbers the pipeline
 * STT stage pins — one constant, both transports.
 *
 * Sent because the S2S default is the service's 0.7, and the interferer that
 * matters is background SPEECH: a television or a second conversation, which
 * only the pre-model filter can suppress (a frame gate cannot tell "a voice"
 * from "the caller's voice"). Measured on tau2-bench retail — see
 * {@link DEFAULT_VOICE_FOCUS_THRESHOLD} for the numbers and for why raising
 * `vad_threshold` instead is a regression in both directions.
 *
 * This closes half of a transport asymmetry: every transcription-side knob the
 * pipeline pins after measurement (`language_codes`, `voice_focus`,
 * `transcription_prompt`, `keyterms`) was unreachable in S2S, so an S2S agent
 * ran on service defaults for all of them. `turn_detection` is deliberately NOT
 * pinned here — its default is adaptive and entity-aware, and setting
 * `min_silence`/`max_silence` turns both off for the rest of the session.
 */
const voiceFocusInput = () => ({
  voice_focus: DEFAULT_VOICE_FOCUS,
  voice_focus_threshold: DEFAULT_VOICE_FOCUS_THRESHOLD,
});

/**
 * Documented cap on `input.transcription_prompt`. Trimmed here rather than left
 * to the service, for the same reason `agent_context` is trimmed in the STT
 * opener: an over-long value is a rejected `session.update` field on a session
 * that otherwise looks healthy, and the failure would surface as unbiased
 * transcription rather than as a config error.
 */
const TRANSCRIPTION_PROMPT_MAX_CHARS = 1750;

/**
 * `input.transcription_prompt` block, or nothing when there is no prompt.
 *
 * Keeps the HEAD, unlike `agent_context`'s tail-keeping trim: this is a
 * standing description of the call's vocabulary written by the agent author, so
 * its opening sentences are the substantive part. `agent_context` keeps the tail
 * because it carries the agent's last reply, whose trailing question is the
 * whole point.
 */
const transcriptionPromptInput = (sttPrompt: string | undefined) => {
  if (sttPrompt === undefined || sttPrompt.trim().length === 0) return {};
  return { transcription_prompt: sttPrompt.slice(0, TRANSCRIPTION_PROMPT_MAX_CHARS) };
};

export type S2sWebSocket = HeaderWebSocket;
export type CreateS2sWebSocket = CreateHeaderWebSocket;
export const defaultCreateS2sWebSocket: CreateS2sWebSocket = defaultCreateHeaderWebSocket;

export type S2sSessionConfig = {
  systemPrompt: string;
  tools: ToolSchema[];
  greeting?: string;
  /**
   * Contextual biasing for transcription — the agent's `sttPrompt`, sent as
   * `input.transcription_prompt`.
   *
   * It used to be pipeline-only, which made it a SILENT config drop: `agent({
   * sttPrompt })` and host mode's `host.sttPrompt` both reached the agent
   * definition, and only `pipeline-transport.ts` ever read it, so an S2S agent
   * that set one got unbiased transcription and no warning. That is the
   * dropped-field bug class the SDK guide warns about — a working agent quietly
   * ignoring part of its own config.
   *
   * It earns its place: the caller's spelled name and ZIP are what gate a task,
   * and on tau2-bench retail adding a transcription prompt took the
   * authenticating first name from 1 of 6 attempts correct to 6 of 6.
   */
  sttPrompt?: string;
  /**
   * Agent voice, sent as `output.voice`. From `assemblyAIS2s({ voice })`;
   * unset leaves the service default.
   */
  voice?: string;
  /**
   * Language codes to bias transcription toward, sent as
   * `input.language_codes`. From `assemblyAIS2s({ languages })`.
   *
   * Unset is MEANINGFUL — it means "detect per turn" — so this is forwarded on
   * its own presence and never defaulted here. See the descriptor's doc for why
   * a host-side `["en"]` would be the mirror-image bug.
   */
  languages?: readonly string[];
  /**
   * Domain terms to bias transcription toward, sent as `input.keyterms`. From
   * `assemblyAIS2s({ keyterms })`.
   */
  keyterms?: readonly string[];
};

/**
 * Callbacks fired into the owning session at construction time.
 *
 * Defined in `_s2s-dispatch.ts` (it is that module's contract — the set of
 * things a wire message can cause) and re-exported here, which is where every
 * consumer already imports it from.
 */
export type { S2sCallbacks } from "./_s2s-dispatch.ts";

export type S2sHandle = {
  sendAudio(audio: Uint8Array): void;
  /**
   * Send a tool result. Returns whether the frame actually went out — false
   * means the socket was not open (e.g. dropped, awaiting resume), and the
   * provider session is still waiting on this result: the caller must queue
   * it for redelivery or the provider-side turn stalls.
   */
  sendToolResult(callId: string, result: string): boolean;
  updateSession(config: S2sSessionConfig): void;
  resumeSession(sessionId: string): void;
  close(): void;
};

export type ConnectS2sOptions = {
  apiKey: string;
  config: S2sConfig;
  createWebSocket: CreateS2sWebSocket;
  callbacks: S2sCallbacks;
  logger?: Logger;
  /**
   * Session id attached to diagnostic log lines (e.g. raw `reply.done`
   * arrivals from the S2S service). Optional; logs omit the field when
   * not provided.
   */
  sid?: string;
  /**
   * Abandons a handshake that has not completed yet — the caller's teardown.
   * Without it a socket stuck between `connect` and `open` can never be closed
   * by anyone: this function only returns a handle once the socket opens, so
   * there is nothing for the caller to close, and `ws` sets no
   * `handshakeTimeout`, so nothing times it out either. A client that hangs up
   * mid-resume then leaves a half-open (billed) provider connection pinned for
   * the life of the process.
   */
  signal?: AbortSignal;
};

export async function connectS2s(opts: ConnectS2sOptions): Promise<S2sHandle> {
  const { apiKey, config, createWebSocket, callbacks, logger: log = consoleLogger, sid } = opts;

  // Already abandoned: never open a socket the caller has no use for.
  opts.signal?.throwIfAborted();

  log.info("S2S connecting", { url: config.wssUrl });

  const ws = createWebSocket(config.wssUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // Drop mic frames while the provider link is stalled (audio is
  // loss-tolerant; a stalled socket must not queue live speech unboundedly).
  // Only sendAudio is gated — control messages always go through.
  const audioGate = createAudioSendGate({
    bufferedAmount: () => ws.bufferedAmount,
    label: "S2S",
    log,
  });

  const dispatchState: DispatchState = {
    speechActive: false,
    reply: createReplyAudit(),
  };
  const dispatchCtx: DispatchContext = sid !== undefined ? { log, sid } : { log };
  // Handlers below stay registered for the socket's whole life; the race routes
  // pre-open failures to the connect and later ones to the session callbacks.
  const connect = createWsOpenRace();

  // Abandon an unfinished handshake (see `signal` above). Once the socket has
  // opened this is a no-op: the caller holds the handle by then and closes it
  // through the normal teardown, which is also what keeps this from racing a
  // session that is already live.
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (!connect.isOpening()) return;
      log.info("S2S connect abandoned before open", { url: config.wssUrl });
      ws.close(WS_NORMAL_CLOSURE);
      connect.fail(new Error("S2S connect abandoned before open"));
    },
    { once: true },
  );

  function send(msg: { type: string; [key: string]: unknown }): boolean {
    if (ws.readyState !== WS_OPEN) {
      log.debug("S2S send dropped: socket not open", { type: msg.type });
      return false;
    }
    const json = JSON.stringify(msg);
    // Per-outbound-message logging is a hot path (one line per wire
    // message); debug-only so the default logger pays nothing.
    if (msg.type === "session.update") {
      log.debug(`S2S >> ${msg.type}`, { payload: json });
    } else if (msg.type !== "input.audio") {
      log.debug(`S2S >> ${msg.type}`);
    }
    ws.send(json);
    return true;
  }

  const handle: S2sHandle = {
    sendAudio(audio: Uint8Array): void {
      if (ws.readyState !== WS_OPEN || audioGate.shouldDrop()) return;
      ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
    },

    sendToolResult(callId: string, result: string): boolean {
      log.info("S2S >> tool.result", { call_id: callId, resultLength: result.length });
      return send({ type: "tool.result", call_id: callId, result });
    },

    updateSession(sessionConfig: S2sSessionConfig): void {
      // All five are destructured OUT rather than left to the spread: they are
      // SDK field names, and `rest` goes onto the wire verbatim, so leaving any
      // of them in would send an unknown key the service rejects.
      const { systemPrompt, sttPrompt, voice, languages, keyterms, ...rest } = sessionConfig;
      send({
        type: "session.update",
        session: {
          system_prompt: systemPrompt,
          ...rest,
          // DECLARED, and spread last so it stays authoritative. Omitting the
          // format is the one S2S failure with NO symptom: the service applies
          // its own rate and then emits nothing at all — no speech edges, no
          // transcript, no error — so the agent greets and is permanently deaf.
          // A declaration the audio does not match at least earns a 1011, which
          // the close path already handles. The transport resamples to exactly
          // this rate, so the number and the bytes cannot drift apart.
          input: {
            ...pcmAudio(config.inputSampleRate),
            ...voiceFocusInput(),
            ...transcriptionPromptInput(sttPrompt),
            // Both forwarded on PRESENCE only. An unset `language_codes` means
            // "detect per turn" service-side, so sending a default here would
            // disable multilingual transcription for every agent.
            ...(languages && languages.length > 0 ? { language_codes: [...languages] } : {}),
            ...(keyterms && keyterms.length > 0 ? { keyterms: [...keyterms] } : {}),
          },
          output: {
            ...pcmAudio(config.outputSampleRate),
            ...omitUndefined({ voice }),
          },
        },
      });
    },

    resumeSession(sessionId: string): void {
      send({ type: "session.resume", session_id: sessionId });
    },

    close(): void {
      log.info("S2S closing");
      // Explicitly Normal Closure. `close()` with no code sends a statusless
      // frame, which both ends then report as 1005 "No Status Received" —
      // indistinguishable in the logs from the peer dropping us, and 1005 is
      // in the transport's TRANSIENT_CLOSE_CODES, so our own teardown would
      // look like something worth resuming.
      ws.close(WS_NORMAL_CLOSURE);
    },
  };

  ws.addEventListener("open", () => {
    log.info("S2S WebSocket open");
    connect.markOpen();
  });

  function logIncoming(type: unknown): void {
    // reply.audio and input.audio are ~95% of traffic — skip logging.
    // reply.done and session.error get richer logs inside dispatch;
    // skip here to avoid a duplicate line.
    if (
      type === "reply.audio" ||
      type === "input.audio" ||
      type === "reply.done" ||
      type === "session.error"
    ) {
      return;
    }
    log.info(`S2S << ${type}`);
  }

  function handleObject(obj: Record<string, unknown>, raw: unknown): void {
    logIncoming(obj.type);
    // Log the full tool.call payload so we can diagnose provider-side
    // empty-args problems — the underlying LLM emitting a function call
    // without populating its required parameters. Without the full
    // payload we cannot tell apart "field-name mismatch" from
    // "model emitted no args." Guarded by the process-wide debug flag
    // (AAI_DEBUG=1) so the stringify itself is skipped when debug is off.
    if (debugLoggingEnabled && obj.type === "tool.call") {
      log.debug("S2S << tool.call payload", { payload: JSON.stringify(obj) });
    }
    if (obj.type === "reply.audio" && typeof obj.data === "string") {
      // The session's own logger, so a dropped reply frame is a line beside the
      // rest of this session's — see `_base64.ts` for the rate and the default.
      const bytes = base64ToUint8(obj.data, log);
      countReplyAudio(dispatchState.reply, bytes.length);
      callbacks.onAudio(bytes);
      return;
    }
    const parsed = parseS2sMessage(obj);
    if (!parsed) {
      log.warn(
        `S2S << unrecognised message type: ${obj.type ?? JSON.stringify(raw).slice(0, LOG_PREVIEW_CHARS)}`,
      );
      return;
    }
    dispatchS2sMessage(callbacks, parsed, dispatchState, dispatchCtx);
  }

  ws.addEventListener("message", (ev) => {
    // The dispatch below fans out into session/tool code; a throw escaping a
    // ws 'message' handler would be an uncaughtException that takes down the
    // host — surface it through the session error path instead.
    try {
      const raw = safeJsonParse(String(ev.data));
      if (raw === undefined) {
        log.warn("S2S << invalid JSON", { data: String(ev.data).slice(0, LOG_PREVIEW_CHARS) });
        return;
      }
      if (!isRecord(raw)) {
        log.warn("S2S << non-object JSON message", { type: typeof raw });
        return;
      }
      handleObject(raw, raw);
    } catch (err) {
      const msg = errorMessage(err);
      log.error("S2S message dispatch failed", { error: msg });
      callbacks.onError(new Error(`S2S message dispatch failed: ${msg}`));
    }
  });

  // Message from a post-open socket `error`, held for the `close` handler.
  // The `ws` library always follows a fatal socket error with `close`, and
  // the close path is where the transport decides between resuming and
  // failing the session — so the error is folded into that decision instead
  // of surfaced on its own. Reporting it immediately sent the client a
  // fatal-looking `error` frame for the most common transient-drop shape
  // (error-then-close), tearing the client down moments before the resume
  // machinery successfully restored a session nobody was listening to.
  let lastSocketError: string | null = null;

  ws.addEventListener("close", (ev) => {
    const code = ev.code ?? 0;
    const reason = ev.reason || (lastSocketError ?? "");
    log.info("S2S WebSocket closed", { code, reason });
    if (connect.isOpening()) {
      connect.fail(new Error(`WebSocket closed before open (code: ${code})`));
    }
    callbacks.onClose(code, reason);
  });

  ws.addEventListener("error", (ev) => {
    const message = typeof ev.message === "string" ? ev.message : "WebSocket error";
    const errObj = new Error(message);
    log.error("S2S WebSocket error", { error: errObj.message });
    if (connect.isOpening()) {
      connect.fail(errObj);
    } else {
      // Deferred to the close handler — see lastSocketError above.
      lastSocketError = message;
    }
  });

  await connect.promise;
  return handle;
}
