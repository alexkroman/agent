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
import { createMessageHandlers } from "./session-core-messages.ts";
import type {
  ConnState,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";
import type { WebSocketConstructor } from "./types.ts";

export type {
  CustomEvent,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";
export type {
  AgentState,
  ChatMessage,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "./types.ts";

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
    });
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WS_OPEN) {
      io.close();
      return;
    }
    conn.voiceIO = io;
    if (conn.preInitAudio.length > 0) {
      for (const chunk of conn.preInitAudio) {
        io.enqueue(chunk.buffer as ArrayBuffer);
      }
      conn.preInitAudio = [];
    }
    deps.sendJson({ type: "audio_ready" });
    deps.updateState({ state: "listening" });
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
    conn.audioSetupInFlight = false;
  }
}

// ─── URL builder ────────────────────────────────────────────────────────────

function buildWsUrl(platformUrl: string, resume: boolean, sessionId?: string): URL {
  const wsUrl = new URL("websocket", platformUrl.endsWith("/") ? platformUrl : `${platformUrl}/`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (sessionId) wsUrl.searchParams.set("sessionId", sessionId);
  else if (resume) wsUrl.searchParams.set("resume", "1");
  return wsUrl;
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
  const WS: WebSocketConstructor =
    options.WebSocket ?? (WebSocket as unknown as WebSocketConstructor);

  // ─── Internal state (replaces signals) ──────────────────────────────────

  let currentSnapshot: SessionSnapshot = {
    state: "disconnected",
    messages: [],
    toolCalls: [],
    customEvents: [],
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: false,
    running: false,
  };

  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const sub of subscribers) sub();
  }

  function updateState(partial: Partial<SessionSnapshot>): void {
    currentSnapshot = { ...currentSnapshot, ...partial };
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
  };
  let connectionController: AbortController | null = null;
  let hasConnected = false;

  function cleanupAudio(): void {
    conn.audioSetupInFlight = false;
    void conn.voiceIO?.close();
    conn.voiceIO = null;
    conn.preInitAudio = [];
  }

  function resetState(): void {
    updateState({
      messages: [],
      toolCalls: [],
      customEvents: [],
      userTranscript: null,
      agentTranscript: null,
      error: null,
    });
  }

  function sendJson(msg: ClientMessage): void {
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  function sendAudio(bytes: Uint8Array): void {
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(bytes as unknown as ArrayBuffer);
    }
  }

  const audioDeps = {
    sendJson,
    sendAudio,
    updateState,
  };

  // ─── Message handling ─────────────────────────────────────────────────────

  const { handleMessage } = createMessageHandlers({ getSnapshot, updateState, conn });

  // ─── Connection management ──────────────────────────────────────────────

  /** Abort the in-flight connection and release audio + WebSocket resources. */
  function teardownConnection(): void {
    connectionController?.abort();
    connectionController = null;
    cleanupAudio();
    conn.ws?.close();
    conn.ws = null;
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

    const resumeId = !hasConnected ? options.resumeSessionId : undefined;
    const wsUrl = buildWsUrl(options.platformUrl, hasConnected, resumeId);

    const socket = new WS(wsUrl.toString());
    socket.binaryType = "arraybuffer";
    conn.ws = socket;

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
        if (config) {
          if (config.sid) options.onSessionId?.(config.sid);
          const isReconnect = hasConnected;
          hasConnected = true;
          initAudioCapture(conn, config, audioDeps).catch((err) => {
            audioDeps.updateState({
              state: "error",
              error: {
                code: "audio",
                message: `Audio capture failed: ${errorMessage(err)}`,
              },
              running: false,
            });
          });

          if (isReconnect && currentSnapshot.messages.length > 0) {
            sendJson({
              type: "history",
              messages: currentSnapshot.messages.map((m) => ({ role: m.role, content: m.content })),
            });
          }
        }
      },
      { signal: sig },
    );

    socket.addEventListener(
      "close",
      () => {
        if (sig.aborted) {
          return;
        }
        controller.abort();
        cleanupAudio();
        updateState({ state: "disconnected", running: false });
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
    updateState({ state: "disconnected", running: false });
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
    [Symbol.dispose]() {
      disconnect();
    },
  };
}
