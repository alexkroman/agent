// Copyright 2025 the AAI authors. MIT license.

/**
 * Framework-agnostic voice session core.
 *
 * Manages WebSocket communication, audio capture/playback, and agent state
 * transitions using a subscribe/getSnapshot pattern compatible with React's
 * `useSyncExternalStore` and other external store consumers.
 *
 * Server→client message interpretation lives in `session-core-messages.ts`;
 * the public/internal type declarations live in `session-core-types.ts`.
 *
 * No dependency on React, Preact, or any UI framework.
 */

import { errorMessage, WS_OPEN } from "@alexkroman1/aai";
import type { ClientMessage } from "@alexkroman1/aai/protocol";
import type { VoiceIO } from "./audio.ts";
import {
  CLEARED_SESSION_STATE,
  createMessageHandlers,
  type SessionConfigMessage,
} from "./session-core-messages.ts";
import {
  cancelPendingReconnect,
  openReconnectingSocket,
  reconnectPending,
} from "./session-core-reconnect.ts";
import type {
  ConnState,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";
import { createUploadSender } from "./session-core-upload.ts";
import { buildWsUrl } from "./session-core-url.ts";
import { MIC_SEND_MAX_BUFFERED_BYTES, type WebSocketConstructor } from "./types.ts";

export type {
  CustomEvent,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";

// ─── Audio initialization ────────────────────────────────────────────────────

/**
 * Initialize audio capture and playback after the server sends a ready config.
 *
 * Lifecycle: dynamically import audio modules -> request microphone access ->
 * register AudioWorklet processors -> create a `VoiceIO` instance -> send
 * `audio_ready` to the server -> transition state to `"listening"`.
 *
 * Uses the connection `generation` counter to detect if `connect()` was called
 * while awaiting async operations; if so, the stale VoiceIO is closed immediately
 * to prevent it from being assigned to a newer connection.
 *
 * On failure (e.g. microphone permission denied, WebSocket closed mid-setup),
 * sets the error state and transitions to `"disconnected"`.
 */
async function initAudioCapture(
  conn: ConnState,
  msg: { sampleRate: number; ttsSampleRate: number },
  deps: {
    sendJson: (msg: ClientMessage) => void;
    sendAudio: (bytes: Uint8Array) => void;
    updateState: (partial: Partial<SessionSnapshot>) => void;
    /** Turn-boundary-guarded drain from the message handlers — replays a
     *  buffered `audio_done` without stomping a barge-in's state. */
    settleWhenAudioDrained: (io: VoiceIO) => void;
  },
): Promise<void> {
  if (conn.audioSetupInFlight) return;
  conn.audioSetupInFlight = true;
  const gen = conn.generation;
  try {
    const [{ createVoiceIO }, captureWorklet, playbackWorklet] = await Promise.all([
      import("./audio.ts"),
      import("./worklets/capture-processor.ts").then((m) => m.default),
      import("./worklets/playback-processor.ts").then((m) => m.default),
    ]);
    const io = await createVoiceIO({
      sttSampleRate: msg.sampleRate,
      ttsSampleRate: msg.ttsSampleRate,
      captureWorkletSrc: captureWorklet,
      playbackWorkletSrc: playbackWorklet,
      onMicData: (pcm16: ArrayBuffer) => {
        try {
          deps.sendAudio(new Uint8Array(pcm16));
        } catch {
          console.debug("[aai-ui] sendAudio dropped: connection closed");
        }
      },
      // A worklet processor crash after setup: the audio path is dead even
      // though the socket is fine, so surface it instead of staying in a
      // healthy-looking listening/speaking state forever.
      onError: (err: Error) => {
        if (conn.generation !== gen) return;
        deps.updateState({
          state: "error",
          error: { code: "audio", message: err.message },
          running: false,
        });
      },
    });
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WS_OPEN) {
      void io.close().catch(() => {
        /* stale connection — nothing to report the failure to */
      });
      return;
    }
    // Defensive: if a previous VoiceIO somehow survived to this point, close
    // it before overwriting the slot — an orphaned instance keeps its mic
    // tracks live and pumps duplicate audio.
    void conn.voiceIO?.close().catch(() => {
      /* already closing */
    });
    conn.voiceIO = io;
    if (conn.preInitAudio.length > 0) {
      for (const chunk of conn.preInitAudio) {
        io.enqueue(chunk.buffer as ArrayBuffer);
      }
      conn.preInitAudio = [];
    }
    deps.sendJson({ type: "audio_ready" });
    deps.updateState({ recording: true });
    // If audio_done arrived while we were initializing, replay it now so the
    // buffered greeting plays to completion (and state flips to "listening"
    // only when playback actually drains) instead of the done being lost.
    if (conn.preInitDone) {
      conn.preInitDone = false;
      deps.settleWhenAudioDrained(io);
    } else {
      deps.updateState({ state: "listening" });
    }
  } catch (err: unknown) {
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WS_OPEN) return;
    deps.updateState({
      state: "error",
      error: {
        code: "audio",
        message: `Microphone access failed: ${errorMessage(err)}`,
      },
      running: false,
    });
  } finally {
    // Only the init that still owns the flag may clear it: a stale
    // generation's settle must not unlock a newer init that is in flight
    // (which would let a second same-generation init start and orphan a
    // live microphone).
    if (conn.generation === gen) conn.audioSetupInFlight = false;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a framework-agnostic voice session core that connects to an AAI
 * server via WebSocket.
 *
 * Uses a subscribe/getSnapshot pattern for state management, compatible with
 * React's `useSyncExternalStore` and other external store integrations.
 *
 * @param options - Session configuration including the platform server URL.
 * @returns A {@link SessionCore} handle for controlling the session.
 *
 * @public
 */
export function createSessionCore(options: SessionCoreOptions): SessionCore {
  // ─── Internal state (replaces signals) ──────────────────────────────────

  let currentSnapshot: SessionSnapshot = {
    ...CLEARED_SESSION_STATE,
    state: "disconnected",
    contentVersion: 0,
    started: false,
    running: false,
    // Voice until the server's config says text-only (audioOut: false).
    audioOut: true,
    recording: false,
    // The programmatic endpoint — same URL the session connects to, minus
    // resume params. Derived up front so UIs can show it before connecting.
    apiUrl: buildWsUrl(options.platformUrl, false).toString(),
  };

  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const sub of subscribers) sub();
  }

  /** Snapshot fields whose changes bump `contentVersion` (rendered conversation content). */
  const contentKeys = ["messages", "toolCalls", "userTranscript", "agentTranscript"] as const;

  function updateState(partial: Partial<SessionSnapshot>): void {
    const contentChanged = contentKeys.some(
      (key) => key in partial && partial[key] !== currentSnapshot[key],
    );
    currentSnapshot = contentChanged
      ? { ...currentSnapshot, ...partial, contentVersion: currentSnapshot.contentVersion + 1 }
      : { ...currentSnapshot, ...partial };
    notify();
  }

  function getSnapshot(): SessionSnapshot {
    return currentSnapshot;
  }

  function subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  }

  // ─── Connection state ───────────────────────────────────────────────────

  const conn: ConnState = {
    ws: null,
    voiceIO: null,
    audioSetupInFlight: false,
    generation: 0,
    preInitAudio: [],
    preInitDone: false,
    readyConfig: null,
  };
  let connectionController: AbortController | null = null;
  let hasConnected = false;

  function cleanupAudio(): void {
    upload.discard();
    conn.audioSetupInFlight = false;
    void conn.voiceIO?.close().catch(() => {
      /* already tearing down — nothing to report the failure to */
    });
    conn.voiceIO = null;
    conn.preInitAudio = [];
    conn.preInitDone = false;
  }

  function resetState(): void {
    updateState(CLEARED_SESSION_STATE);
  }

  function sendJson(msg: ClientMessage): void {
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  function sendAudio(bytes: Uint8Array): void {
    if (!conn.ws || conn.ws.readyState !== WS_OPEN) return;
    // Backpressure: if the socket's send queue is backed up (slow network),
    // drop this frame instead of queueing. Queued mic audio only adds latency
    // and flushes stale speech into STT once the connection recovers.
    if (conn.ws.bufferedAmount > MIC_SEND_MAX_BUFFERED_BYTES) return;
    conn.ws.send(bytes as unknown as ArrayBuffer);
  }

  // ─── File uploads ─────────────────────────────────────────────────────────

  const upload = createUploadSender({ conn, getSnapshot, sendJson });

  // ─── Message handling ─────────────────────────────────────────────────────

  const { handleMessage, settleWhenAudioDrained } = createMessageHandlers({
    getSnapshot,
    updateState,
    conn,
    discardUpload: upload.discard,
  });

  const audioDeps = {
    sendJson,
    sendAudio,
    updateState,
    settleWhenAudioDrained,
  };

  // ─── Connection management ──────────────────────────────────────────────

  /** Abort the in-flight connection and release audio + WebSocket resources. */
  function teardownConnection(): void {
    connectionController?.abort();
    connectionController = null;
    cleanupAudio();
    conn.ws?.close();
    conn.ws = null;
  }

  /** React to the server's `config` message: record it, set up the audio
   *  path for the session's mode, and replay history on reconnect. */
  function onServerConfig(config: SessionConfigMessage): void {
    if (config.sid) options.onSessionId?.(config.sid);
    const isReconnect = hasConnected;
    hasConnected = true;
    conn.readyConfig = { sampleRate: config.sampleRate, ttsSampleRate: config.ttsSampleRate };
    const audioOut = config.audioOut !== false;
    updateState({ audioOut });
    if (audioOut) {
      // initAudioCapture handles its own failures (sets error state internally).
      void initAudioCapture(conn, config, audioDeps);
    } else {
      // Text-only session: no playback pipeline, and the mic is opt-in
      // via startRecording() (the record button) — so the protocol
      // handshake completes immediately with no permission prompt.
      sendJson({ type: "audio_ready" });
      updateState({ state: "listening" });
    }

    if (isReconnect && currentSnapshot.messages.length > 0) {
      sendJson({
        type: "history",
        messages: currentSnapshot.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    }
  }

  /**
   * The WebSocket URL for the *next* connection attempt. Evaluated per
   * attempt (partysocket takes it as a URL provider), so once the first
   * `config` arrives, every reconnect — automatic or explicit — carries
   * `resume=1` and the session resumes instead of starting over.
   */
  function currentWsUrl(): string {
    const resumeId = !hasConnected ? options.resumeSessionId : undefined;
    return buildWsUrl(options.platformUrl, hasConnected, resumeId).toString();
  }

  /** Open a socket: an injected constructor as-is (tests), or partysocket's
   *  reconnecting WebSocket — same interface, plus reconnect-on-close. */
  function openSocket(): InstanceType<WebSocketConstructor> {
    if (options.WebSocket) return new options.WebSocket(currentWsUrl());
    const socket = openReconnectingSocket(currentWsUrl);
    return socket as unknown as InstanceType<WebSocketConstructor>;
  }

  function connect(opts?: { signal?: AbortSignal }): void {
    updateState({ state: "connecting", error: null });
    teardownConnection();
    conn.generation++;
    const controller = new AbortController();
    connectionController = controller;
    const { signal: sig } = controller;

    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => disconnect(), {
        signal: sig,
      });
    }

    const socket = openSocket();
    socket.binaryType = "arraybuffer";
    conn.ws = socket;

    // Browsers fire "error" with no payload and always follow it with
    // "close" — record that it happened so the close handler can report a
    // connection error instead of a plain disconnect.
    let socketErrored = false;

    socket.addEventListener(
      "open",
      () => {
        updateState({ state: "ready" });
      },
      { signal: sig },
    );

    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        const config = handleMessage(event.data);
        if (config) onServerConfig(config);
      },
      { signal: sig },
    );

    socket.addEventListener(
      "error",
      () => {
        socketErrored = true;
      },
      { signal: sig },
    );

    socket.addEventListener(
      "close",
      () => {
        if (sig.aborted) {
          return;
        }
        cleanupAudio();
        if (reconnectPending(socket)) {
          // partysocket retries with backoff. Keep the listeners attached
          // and the session logically alive: the URL provider re-derives the
          // resume URL and `onServerConfig` replays history on the next open.
          // A socket error here is part of the retry cycle, not terminal —
          // clear it so a later clean disconnect isn't misreported.
          socketErrored = false;
          updateState({ state: "connecting", recording: false });
          return;
        }
        // Terminal: explicit close, or retries exhausted — cancel any
        // still-scheduled attempt before tearing down.
        cancelPendingReconnect(socket);
        controller.abort();
        if (socketErrored) {
          updateState({
            state: "error",
            error: { code: "connection", message: "WebSocket connection error" },
            running: false,
            recording: false,
          });
        } else {
          updateState({ state: "disconnected", running: false, recording: false });
        }
      },
      { signal: sig },
    );
  }

  function cancel(): void {
    conn.voiceIO?.flush();
    updateState({ state: "listening" });
    sendJson({ type: "cancel" });
  }

  function reset(): void {
    upload.discard();
    conn.voiceIO?.flush();
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      sendJson({ type: "reset" });
      return;
    }
    resetState();
    disconnect();
    connect();
  }

  function disconnect(): void {
    teardownConnection();
    updateState({ state: "disconnected", running: false, recording: false });
  }

  function startRecording(): void {
    // Voice sessions stream the mic for their whole lifetime already; while a
    // file upload is in flight the mic stays off so the streams can't mix.
    if (
      currentSnapshot.audioOut ||
      currentSnapshot.recording ||
      conn.audioSetupInFlight ||
      upload.inFlight()
    )
      return;
    const cfg = conn.readyConfig;
    if (!(cfg && conn.ws) || conn.ws.readyState !== WS_OPEN) return;
    // Sets `recording: true` (and error state on mic denial) itself.
    void initAudioCapture(conn, cfg, audioDeps);
  }

  function stopRecording(): void {
    if (currentSnapshot.audioOut || !currentSnapshot.recording) return;
    cleanupAudio();
    updateState({ recording: false });
  }

  function start(): void {
    updateState({ started: true, running: true });
    connect();
  }

  function toggle(): void {
    if (currentSnapshot.running) {
      disconnect();
    } else {
      updateState({ running: true });
      connect();
    }
  }

  return {
    getSnapshot,
    subscribe,
    connect,
    cancel,
    resetState,
    reset,
    disconnect,
    start,
    toggle,
    startRecording,
    stopRecording,
    sendAudioFile: upload.sendAudioFile,
    [Symbol.dispose]() {
      disconnect();
    },
  };
}
