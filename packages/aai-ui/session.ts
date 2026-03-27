// Copyright 2025 the AAI authors. MIT license.

import type { ClientMessage, ReadyConfig } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { VoiceIO } from "./audio.ts";
import { ClientHandler } from "./client-handler.ts";
import type {
  AgentState,
  ChatMessage,
  Reactive,
  SessionError,
  ToolCallInfo,
  VoiceSessionOptions,
} from "./types.ts";

export { ClientHandler } from "./client-handler.ts";
export type {
  AgentState,
  ChatMessage,
  Reactive,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
} from "./types.ts";

/** Built-in non-reactive container (plain mutable wrapper). */
function plainReactive<T>(initial: T): Reactive<T> {
  return { value: initial };
}

/** No-op batch — just calls the function. */
function plainBatch(fn: () => void): void {
  fn();
}

// ─── Audio initialization (extracted for function-length limit) ──────────────

/**
 * Shared mutable connection state for audio initialization.
 *
 * Tracks the active WebSocket, VoiceIO instance, and a generation counter
 * that prevents stale async operations (e.g. a slow `initAudioCapture`) from
 * assigning their results to a newer connection after a reconnect.
 */
type ConnState = {
  ws: WebSocket | null;
  voiceIO: VoiceIO | null;
  audioSetupInFlight: boolean;
  /** Monotonically increasing counter bumped on each connect(). Prevents a stale
   *  initAudioCapture from assigning its voiceIO to a newer connection. */
  generation: number;
};

/**
 * Initialize audio capture and playback after the server sends a ready config.
 *
 * Lifecycle: dynamically import audio modules → request microphone access →
 * register AudioWorklet processors → create a `VoiceIO` instance → send
 * `audio_ready` to the server → transition state to `"listening"`.
 *
 * Uses the connection `generation` counter to detect if `connect()` was called
 * while awaiting async operations; if so, the stale VoiceIO is closed immediately
 * to prevent it from being assigned to a newer connection.
 *
 * On failure (e.g. microphone permission denied, WebSocket closed mid-setup),
 * sets the error state and transitions to `"error"`.
 *
 * @param conn - The shared mutable connection state (WebSocket, VoiceIO, generation).
 * @param msg - The `ReadyConfig` from the server containing audio sample rates.
 * @param deps.send - Send a typed client message over the WebSocket.
 * @param deps.sendBinary - Send raw binary audio data over the WebSocket.
 * @param deps.state - Reactive state signal for the agent's current state.
 * @param deps.error - Reactive signal for session errors.
 * @param deps.batch - Batching function for grouping reactive updates.
 */
async function initAudioCapture(
  conn: ConnState,
  msg: ReadyConfig,
  deps: {
    send: (msg: ClientMessage) => void;
    sendBinary: (data: ArrayBuffer) => void;
    state: Reactive<AgentState>;
    error: Reactive<SessionError | null>;
    batch: (fn: () => void) => void;
  },
): Promise<void> {
  if (conn.audioSetupInFlight) return;
  conn.audioSetupInFlight = true;
  // Capture the connection generation so we can detect if connect() was
  // called while we were awaiting. Without this, a stale initAudioCapture
  // could assign its voiceIO to a newer connection.
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
        // Always stream audio — S2S handles VAD natively.
        try {
          deps.sendBinary(pcm16);
        } catch {
          console.debug("[aai-ui] sendBinary dropped: connection closed");
        }
      },
    });
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      io.close();
      return;
    }
    conn.voiceIO = io;
    deps.send({ type: "audio_ready" });
    deps.state.value = "listening";
  } catch (err: unknown) {
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
    deps.batch(() => {
      deps.error.value = {
        code: "audio",
        message: `Microphone access failed: ${errorMessage(err)}`,
      };
      deps.state.value = "error";
    });
  } finally {
    conn.audioSetupInFlight = false;
  }
}

// ─── Voice session type ──────────────────────────────────────────────────────

/**
 * A reactive voice session that manages WebSocket communication,
 * audio capture/playback, and agent state transitions.
 *
 * Uses plain JSON text frames and binary audio frames for communication
 * and native WebSocket for the connection.
 *
 * Implements `Disposable` for resource cleanup via `using`.
 *
 * @public
 */
export type VoiceSession = {
  /** Current agent state (connecting, listening, thinking, etc.). */
  readonly state: Reactive<AgentState>;
  /** Chat message history for the session. */
  readonly messages: Reactive<ChatMessage[]>;
  /** Active tool calls for the current turn. */
  readonly toolCalls: Reactive<ToolCallInfo[]>;
  /**
   * Live user utterance from STT/VAD.
   * `null` = not speaking, `""` = speech detected but no text yet,
   * non-empty string = partial/final transcript text.
   */
  readonly userUtterance: Reactive<string | null>;
  /**
   * Streaming agent response text.
   * `null` = not speaking, non-empty string = accumulated delta text.
   * Cleared when the final `chat` message arrives.
   */
  readonly agentUtterance: Reactive<string | null>;
  /** Current session error, or `null` if no error. */
  readonly error: Reactive<SessionError | null>;
  /** Disconnection info, or `null` if connected. */
  readonly disconnected: Reactive<{ intentional: boolean } | null>;
  /**
   * Open a WebSocket connection to the server and begin audio capture.
   *
   * @param options - Optional connection options. `signal` is an AbortSignal that, when aborted, disconnects the session.
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
  /** Alias for `disconnect` for use with `using`. */
  [Symbol.dispose](): void;
};

// ─── Voice session factory ───────────────────────────────────────────────────

function buildWsUrl(platformUrl: string, resume: boolean, sessionId?: string): URL {
  const wsUrl = new URL("websocket", platformUrl.endsWith("/") ? platformUrl : `${platformUrl}/`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (sessionId) wsUrl.searchParams.set("sessionId", sessionId);
  else if (resume) wsUrl.searchParams.set("resume", "1");
  return wsUrl;
}

/**
 * Create a voice session that connects to an AAI server via WebSocket.
 *
 * Uses plain JSON text frames and binary audio frames for communication.
 *
 * @param options - Session configuration including the platform server URL.
 * @returns A {@link VoiceSession} handle for controlling the session.
 *
 * @public
 */
export function createVoiceSession(options: VoiceSessionOptions): VoiceSession {
  const reactive = options.reactiveFactory ?? plainReactive;
  const batchFn = options.batch ?? plainBatch;

  const state = reactive<AgentState>("disconnected");
  const messages = reactive<ChatMessage[]>([]);
  const toolCalls = reactive<ToolCallInfo[]>([]);
  const userUtterance = reactive<string | null>(null);
  const agentUtterance = reactive<string | null>(null);
  const error = reactive<SessionError | null>(null);
  const disconnected = reactive<{ intentional: boolean } | null>(null);

  const conn: ConnState = { ws: null, voiceIO: null, audioSetupInFlight: false, generation: 0 };
  let connectionController: AbortController | null = null;
  let hasConnected = false;

  function cleanupAudio(): void {
    conn.audioSetupInFlight = false;
    void conn.voiceIO?.close();
    conn.voiceIO = null;
  }

  function resetState(): void {
    batchFn(() => {
      messages.value = [];
      toolCalls.value = [];
      userUtterance.value = null;
      agentUtterance.value = null;
      error.value = null;
    });
  }

  function send(msg: ClientMessage): void {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  function sendBinary(data: ArrayBuffer): void {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }

  const audioDeps = { send, sendBinary, state, error, batch: batchFn };

  function connect(opts?: { signal?: AbortSignal }): void {
    disconnected.value = null;
    state.value = "connecting";
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

    const socket = new WebSocket(wsUrl.toString());
    socket.binaryType = "arraybuffer";
    conn.ws = socket;

    const handler = new ClientHandler({
      state,
      messages,
      toolCalls,
      userUtterance,
      agentUtterance,
      error,
      voiceIO: () => conn.voiceIO,
      batch: batchFn,
    });

    socket.addEventListener(
      "open",
      () => {
        state.value = "ready";
      },
      { signal: sig },
    );

    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        const config = handler.handleMessage(event.data);
        if (config) {
          if (config.sessionId) options.onSessionId?.(config.sessionId);
          const isReconnect = hasConnected;
          hasConnected = true;
          initAudioCapture(conn, config, audioDeps).catch((err) => {
            audioDeps.batch(() => {
              audioDeps.error.value = {
                code: "audio",
                message: `Audio capture failed: ${errorMessage(err)}`,
              };
              audioDeps.state.value = "error";
            });
          });

          // Send history if reconnecting
          if (isReconnect && messages.value.length > 0) {
            send({
              type: "history",
              messages: messages.value.map((m) => ({ role: m.role, content: m.content })),
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
        disconnected.value = { intentional: false };
        cleanupAudio();
        state.value = "disconnected";
      },
      { signal: sig },
    );
  }

  function cancel(): void {
    conn.voiceIO?.flush();
    state.value = "listening";
    send({ type: "cancel" });
  }

  function reset(): void {
    conn.voiceIO?.flush();
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      send({ type: "reset" });
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
    state.value = "disconnected";
    disconnected.value = { intentional: true };
  }

  return {
    state,
    messages,
    toolCalls,
    userUtterance,
    agentUtterance,
    error,
    disconnected,
    connect,
    cancel,
    resetState,
    reset,
    disconnect,
    [Symbol.dispose]() {
      disconnect();
    },
  };
}
