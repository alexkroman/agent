// Copyright 2025 the AAI authors. MIT license.

// biome-ignore lint/correctness/noUnresolvedImports: workspace dependency resolved at build time
import type { ClientMessage, ReadyConfig } from "@alexkroman1/aai/protocol";
// biome-ignore lint/correctness/noUnresolvedImports: workspace dependency resolved at build time
import { toWireMessages } from "@alexkroman1/aai/protocol";
// biome-ignore lint/correctness/noUnresolvedImports: workspace dependency resolved at build time
import { errorMessage } from "@alexkroman1/aai/utils";
import type { VoiceIO } from "./audio.ts";
import { ClientHandler } from "./client-handler.ts";
import type {
  AgentState,
  Message,
  Reactive,
  SessionError,
  SessionOptions,
  ToolCallInfo,
} from "./types.ts";

export { ClientHandler } from "./client-handler.ts";
export type {
  AgentState,
  Message,
  Reactive,
  SessionError,
  SessionErrorCode,
  SessionOptions,
  ToolCallInfo,
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

/** Shared mutable connection state for audio initialization. */
type ConnState = {
  ws: WebSocket | null;
  voiceIO: VoiceIO | null;
  audioSetupInFlight: boolean;
};

/** Initialize audio capture/playback after the server sends a ready config. */
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
          /* connection may be closed */
        }
      },
    });
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      io.close();
      return;
    }
    conn.voiceIO = io;
    deps.send({ type: "audio_ready" });
    deps.state.value = "listening";
  } catch (err: unknown) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
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
  readonly messages: Reactive<Message[]>;
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
export function createVoiceSession(options: SessionOptions): VoiceSession {
  const reactive = options.signal ?? plainReactive;
  const batchFn = options.batch ?? plainBatch;

  const state = reactive<AgentState>("disconnected");
  const messages = reactive<Message[]>([]);
  const toolCalls = reactive<ToolCallInfo[]>([]);
  const userUtterance = reactive<string | null>(null);
  const agentUtterance = reactive<string | null>(null);
  const error = reactive<SessionError | null>(null);
  const disconnected = reactive<{ intentional: boolean } | null>(null);

  const conn: ConnState = { ws: null, voiceIO: null, audioSetupInFlight: false };
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
    const controller = new AbortController();
    connectionController = controller;
    const { signal: sig } = controller;

    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => disconnect(), {
        signal: sig,
      });
    }

    const base = options.platformUrl;
    const wsUrl = new URL("websocket", base.endsWith("/") ? base : `${base}/`);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    if (hasConnected) wsUrl.searchParams.set("resume", "1");

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
      (event: Event) => {
        const msgEvent = event as MessageEvent;
        const config = handler.handleMessage(msgEvent.data);
        if (config) {
          const isReconnect = hasConnected;
          hasConnected = true;
          void initAudioCapture(conn, config, audioDeps);

          // Send history if reconnecting
          if (isReconnect && messages.value.length > 0) {
            send({
              type: "history",
              messages: toWireMessages(messages.value),
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
