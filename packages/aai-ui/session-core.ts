// Copyright 2025 the AAI authors. MIT license.

/**
 * Framework-agnostic voice session core.
 *
 * Manages WebSocket communication, audio capture/playback, and agent state
 * transitions using a subscribe/getSnapshot pattern compatible with React's
 * `useSyncExternalStore` and other external store consumers.
 *
 * No dependency on React, Preact, or any UI framework.
 */

import { errorMessage, WS_OPEN } from "@alexkroman1/aai";
import {
  type ClientEvent,
  type ClientMessage,
  lenientParse,
  type ServerMessage,
  ServerMessageSchema,
} from "@alexkroman1/aai/protocol";
import type { VoiceIO } from "./audio.ts";
import type {
  AgentState,
  ChatMessage,
  SessionError,
  ToolCallInfo,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "./types.ts";

export type {
  AgentState,
  ChatMessage,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "./types.ts";

/** Cap on `customEvents` retained in the session snapshot to avoid unbounded growth. */
const MAX_CUSTOM_EVENTS = 200;

/** Cap on `messages` retained in the session snapshot; mirrors host-side DEFAULT_MAX_HISTORY. */
const MAX_MESSAGES = 200;

function appendCapped<T>(list: readonly T[], item: T, cap: number): T[] {
  const next = [...list, item];
  return next.length > cap ? next.slice(-cap) : next;
}

// ─── Snapshot type ──────────────────────────────────────────────────────────

/**
 * A custom event emitted by the agent via `ctx.send`.
 *
 * @public
 */
export type CustomEvent = {
  readonly id: number;
  readonly event: string;
  readonly data: unknown;
};

/**
 * Immutable snapshot of the session state.
 *
 * Consumers (e.g. React hooks via `useSyncExternalStore`) read this to render.
 * A new object reference is created on every state change.
 *
 * @public
 */
export type SessionSnapshot = {
  readonly state: AgentState;
  readonly messages: ChatMessage[];
  readonly toolCalls: ToolCallInfo[];
  readonly customEvents: CustomEvent[];
  readonly userTranscript: string | null;
  readonly agentTranscript: string | null;
  readonly error: SessionError | null;
  readonly started: boolean;
  readonly running: boolean;
};

// ─── SessionCore type ───────────────────────────────────────────────────────

/**
 * A framework-agnostic voice session that manages WebSocket communication,
 * audio capture/playback, and agent state transitions.
 *
 * Uses a subscribe/getSnapshot pattern (compatible with React's
 * `useSyncExternalStore`). Implements `Disposable` for resource cleanup.
 *
 * @public
 */
export type SessionCore = {
  /** Return the current immutable state snapshot. */
  getSnapshot(): SessionSnapshot;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void;
  /**
   * Open a WebSocket connection to the server and begin audio capture.
   * @param options - Optional. `signal` is an AbortSignal that, when aborted, disconnects the session.
   */
  connect(options?: { signal?: AbortSignal }): void;
  /** Cancel the current agent turn and discard in-flight TTS audio. */
  cancel(): void;
  /** Clear messages, transcript, and error state without disconnecting. */
  resetState(): void;
  /** Reset the session: clear state and reconnect. */
  reset(): void;
  /** Close the WebSocket and release all audio resources. */
  disconnect(): void;
  /** Start the session for the first time (sets `started` and `running`). */
  start(): void;
  /** Toggle between connected and disconnected states. */
  toggle(): void;
  /** Alias for `disconnect` for use with `using`. */
  [Symbol.dispose](): void;
};

export type SessionCoreOptions = VoiceSessionOptions;

// ─── Audio initialization ────────────────────────────────────────────────────

/**
 * Shared mutable connection state for audio initialization.
 *
 * Tracks the active WebSocket, VoiceIO instance, and a generation counter
 * that prevents stale async operations (e.g. a slow `initAudioCapture`) from
 * assigning their results to a newer connection after a reconnect.
 */
type ConnState = {
  ws: InstanceType<WebSocketConstructor> | null;
  voiceIO: VoiceIO | null;
  audioSetupInFlight: boolean;
  /** Monotonically increasing counter bumped on each connect(). Prevents a stale
   *  initAudioCapture from assigning its voiceIO to a newer connection. */
  generation: number;
};

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

  const conn: ConnState = { ws: null, voiceIO: null, audioSetupInFlight: false, generation: 0 };
  let connectionController: AbortController | null = null;
  let hasConnected = false;

  function cleanupAudio(): void {
    conn.audioSetupInFlight = false;
    void conn.voiceIO?.close();
    conn.voiceIO = null;
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

  /** Incremented on each turn boundary -- stale async callbacks compare against this. */
  let handlerGeneration = 0;

  /** Monotonically increasing counter for custom events -- used by useEvent to deduplicate. */
  let customEventSeq = 0;

  function appendCustomEvent(name: string, data: unknown): void {
    updateState({
      customEvents: appendCapped(
        currentSnapshot.customEvents,
        { id: ++customEventSeq, event: name, data },
        MAX_CUSTOM_EVENTS,
      ),
    });
  }

  function handleUserTranscriptEvent(text: string): void {
    handlerGeneration++;
    updateState({
      userTranscript: null,
      messages: appendCapped(
        currentSnapshot.messages,
        { role: "user" as const, content: text },
        MAX_MESSAGES,
      ),
      state: "thinking",
    });
  }

  function handleAgentTranscriptEvent(text: string): void {
    updateState({
      agentTranscript: null,
      messages: appendCapped(
        currentSnapshot.messages,
        { role: "assistant" as const, content: text },
        MAX_MESSAGES,
      ),
    });
  }

  /** Single entry point for all server->client session events. */
  function handleEvent(e: ClientEvent): void {
    // Clear error state when a non-error event arrives — proves the session
    // is functional (e.g. audio init failed but WebSocket still works).
    if (currentSnapshot.state === "error" && e.type !== "error") {
      updateState({ state: "disconnected", error: null });
    }

    switch (e.type) {
      case "speech_started":
        updateState({ userTranscript: "" });
        break;
      case "speech_stopped":
        // VAD detected end of speech -- processing will follow.
        break;
      case "user_transcript":
        handleUserTranscriptEvent(e.text);
        break;
      case "agent_transcript":
        handleAgentTranscriptEvent(e.text);
        break;
      case "tool_call":
        updateState({
          toolCalls: [
            ...currentSnapshot.toolCalls,
            {
              callId: e.toolCallId,
              name: e.toolName,
              args: (e.args ?? {}) as Record<string, unknown>,
              status: "pending",
              afterMessageIndex: currentSnapshot.messages.length - 1,
            },
          ],
        });
        break;
      case "tool_call_done": {
        const tcs = currentSnapshot.toolCalls;
        const idx = tcs.findIndex((tc) => tc.callId === e.toolCallId);
        if (idx !== -1) {
          const updated = [...tcs];
          const existing = updated[idx];
          if (existing) updated[idx] = { ...existing, status: "done", result: e.result };
          updateState({ toolCalls: updated });
        }
        break;
      }
      case "reply_done":
        updateState({ state: "listening" });
        break;
      case "cancelled":
        handlerGeneration++;
        conn.voiceIO?.flush();
        updateState({
          userTranscript: null,
          agentTranscript: null,
          state: "listening",
        });
        break;
      case "reset": {
        handlerGeneration++;
        conn.voiceIO?.flush();
        updateState({
          messages: [],
          toolCalls: [],
          customEvents: [],
          userTranscript: null,
          agentTranscript: null,
          error: null,
          state: "listening",
        });
        break;
      }
      case "custom_event":
        appendCustomEvent(e.event, e.data);
        break;
      case "error":
        console.error("Agent error:", e.message);
        updateState({
          state: "error",
          error: { code: e.code, message: e.message },
          running: false,
        });
        break;
      case "idle_timeout":
        // Server-side idle timeout — treat as a graceful disconnect signal.
        break;
      default:
        break;
    }
  }

  /** Enqueue a PCM16 audio chunk for playback. Transitions state to `"speaking"` on the first chunk. */
  function playAudioChunk(chunk: Uint8Array): void {
    if (currentSnapshot.state === "disconnected" && currentSnapshot.error !== null) return;
    if (currentSnapshot.state !== "speaking") {
      updateState({ state: "speaking" });
    }
    conn.voiceIO?.enqueue(chunk.buffer as ArrayBuffer);
  }

  /**
   * Signal that the server has finished sending audio for this turn.
   * Waits for the audio queue to drain, then transitions state to `"listening"`.
   * Uses the `handlerGeneration` counter to discard stale completions from interrupted turns.
   */
  function playAudioDone(): void {
    const gen = handlerGeneration;
    const io = conn.voiceIO;
    if (io) {
      void io
        .done()
        .then(() => {
          if (handlerGeneration !== gen) return;
          updateState({ state: "listening" });
        })
        .catch((err: unknown) => {
          console.warn("Audio playback done failed:", err);
        });
    } else {
      updateState({ state: "listening" });
    }
  }

  /**
   * Dispatch an incoming WebSocket message.
   *
   * Binary frames carry raw PCM16 audio chunks. Text frames are JSON-encoded
   * {@link ServerMessage} values validated via Zod.
   *
   * Returns the parsed config if the message is a `config` message,
   * otherwise `undefined`.
   */
  function handleMessage(
    data: unknown,
  ): { sampleRate: number; ttsSampleRate: number; sid?: string | undefined } | undefined {
    if (data instanceof ArrayBuffer) {
      playAudioChunk(new Uint8Array(data));
      return;
    }
    if (typeof data !== "string") {
      console.warn("session-core: non-string, non-binary frame received; dropping");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      console.warn("session-core: invalid JSON; dropping");
      return;
    }
    const parsed = lenientParse(ServerMessageSchema, raw);
    if (!parsed.ok) {
      if (parsed.malformed) {
        console.warn("session-core: malformed server message", parsed.error);
      }
      // else: unrecognised type — silently drop (rolling-upgrade tolerance)
      return;
    }
    const msg = parsed.data;
    if (msg.type === "config") {
      return {
        sampleRate: msg.sampleRate,
        ttsSampleRate: msg.ttsSampleRate,
        sid: msg.sessionId,
      };
    }
    if (msg.type === "audio_done") {
      playAudioDone();
      return;
    }
    // Everything else is a ClientEvent.
    handleEvent(msg);
  }

  // ─── Connection management ──────────────────────────────────────────────

  function connect(opts?: { signal?: AbortSignal }): void {
    updateState({ state: "connecting", error: null });
    connectionController?.abort();
    cleanupAudio();
    conn.ws?.close();
    conn.ws = null;
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
    connectionController?.abort();
    connectionController = null;
    cleanupAudio();
    conn.ws?.close();
    conn.ws = null;
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
