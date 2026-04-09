// Copyright 2025 the AAI authors. MIT license.

import type {
  ClientEvent,
  ClientMessage,
  ReadyConfig,
  ServerMessage,
} from "@alexkroman1/aai/protocol";
import { lenientParse, ReadyConfigSchema, ServerMessageSchema } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
// biome-ignore lint/correctness/noUndeclaredDependencies: preact migration in progress (Task 3)
import { batch, effect, type Signal, signal } from "@preact/signals";
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

const WS_OPEN = 1;

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
    state: Signal<AgentState>;
    error: Signal<SessionError | null>;
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
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WS_OPEN) {
      io.close();
      return;
    }
    conn.voiceIO = io;
    deps.send({ type: "audio_ready" });
    deps.state.value = "listening";
  } catch (err: unknown) {
    if (conn.generation !== gen || !conn.ws || conn.ws.readyState !== WS_OPEN) return;
    deps.batch(() => {
      deps.error.value = {
        code: "audio",
        message: `Microphone access failed: ${errorMessage(err)}`,
      };
      deps.state.value = "error" as AgentState;
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
  readonly state: Signal<AgentState>;
  /** Chat message history for the session. */
  readonly messages: Signal<ChatMessage[]>;
  /** Active tool calls for the current turn. */
  readonly toolCalls: Signal<ToolCallInfo[]>;
  /**
   * Live user utterance from STT/VAD.
   * `null` = not speaking, `""` = speech detected but no text yet,
   * non-empty string = partial/final transcript text.
   */
  readonly userUtterance: Signal<string | null>;
  /**
   * Streaming agent response text.
   * `null` = not speaking, non-empty string = accumulated delta text.
   * Cleared when the final `chat` message arrives.
   */
  readonly agentUtterance: Signal<string | null>;
  /** Current session error, or `null` if no error. */
  readonly error: Signal<SessionError | null>;
  /** Disconnection info, or `null` if connected. */
  readonly disconnected: Signal<{ intentional: boolean } | null>;
  /** Whether the session has been started by the user. */
  readonly started: Signal<boolean>;
  /** Whether the session is currently running (connected or connecting). */
  readonly running: Signal<boolean>;
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
  /** Start the session for the first time (sets `started` and `running`). */
  start(): void;
  /** Toggle between connected and disconnected states. */
  toggle(): void;
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
  const WS: WebSocketConstructor =
    options.WebSocket ?? (WebSocket as unknown as WebSocketConstructor);

  const state = signal<AgentState>("disconnected");
  const messages = signal<ChatMessage[]>([]);
  const toolCalls = signal<ToolCallInfo[]>([]);
  const userUtterance = signal<string | null>(null);
  const agentUtterance = signal<string | null>(null);
  const error = signal<SessionError | null>(null);
  const disconnected = signal<{ intentional: boolean } | null>(null);
  const started = signal(false);
  const running = signal(true);

  // Track error state to auto-clear running
  // Note: "error" is not in AgentState (it is transitional — will be removed in Task 3)
  const disposeEffect = effect(() => {
    if ((state.value as string) === "error") running.value = false;
  });

  const conn: ConnState = { ws: null, voiceIO: null, audioSetupInFlight: false, generation: 0 };
  let connectionController: AbortController | null = null;
  let hasConnected = false;

  function cleanupAudio(): void {
    conn.audioSetupInFlight = false;
    void conn.voiceIO?.close();
    conn.voiceIO = null;
  }

  function resetState(): void {
    batch(() => {
      messages.value = [];
      toolCalls.value = [];
      userUtterance.value = null;
      agentUtterance.value = null;
      error.value = null;
    });
  }

  function send(msg: ClientMessage): void {
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  function sendBinary(data: ArrayBuffer): void {
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(data);
    }
  }

  const audioDeps = { send, sendBinary, state, error, batch };

  // ─── Message handling ───────────────────────────────────────────────────────

  /** Incremented on each turn boundary — stale async callbacks compare against this. */
  let handlerGeneration = 0;
  /** Accumulated agent_transcript_delta text for real-time display. */
  let deltaAccum = "";

  /** Single entry point for all server→client session events. */
  function handleEvent(e: ClientEvent): void {
    switch (e.type) {
      case "speech_started":
        userUtterance.value = "";
        break;
      case "speech_stopped":
        // VAD detected end of speech — processing will follow.
        break;
      case "user_transcript_delta":
        userUtterance.value = e.text;
        break;
      case "user_transcript":
        handlerGeneration++;
        deltaAccum = "";
        batch(() => {
          userUtterance.value = null;
          messages.value = [...messages.value, { role: "user", content: e.text }];
          state.value = "thinking";
        });
        break;
      case "agent_transcript_delta":
        deltaAccum += (deltaAccum ? " " : "") + e.text;
        agentUtterance.value = deltaAccum;
        break;
      case "agent_transcript":
        deltaAccum = "";
        batch(() => {
          agentUtterance.value = null;
          messages.value = [...messages.value, { role: "assistant", content: e.text }];
        });
        break;
      case "tool_call":
        toolCalls.value = [
          ...toolCalls.value,
          {
            callId: e.toolCallId,
            name: e.toolName,
            args: e.args,
            status: "pending",
            afterMessageIndex: messages.value.length - 1,
          },
        ];
        break;
      case "tool_call_done": {
        const tcs = toolCalls.value;
        const idx = tcs.findIndex((tc) => tc.callId === e.toolCallId);
        if (idx !== -1) {
          const updated = [...tcs];
          const existing = updated[idx];
          if (existing) updated[idx] = { ...existing, status: "done", result: e.result };
          toolCalls.value = updated;
        }
        break;
      }
      case "reply_done":
        state.value = "listening";
        break;
      case "cancelled":
        handlerGeneration++;
        conn.voiceIO?.flush();
        batch(() => {
          userUtterance.value = null;
          agentUtterance.value = null;
          state.value = "listening";
        });
        break;
      case "reset": {
        handlerGeneration++;
        conn.voiceIO?.flush();
        batch(() => {
          messages.value = [];
          toolCalls.value = [];
          userUtterance.value = null;
          agentUtterance.value = null;
          error.value = null;
          state.value = "listening";
        });
        break;
      }
      case "error":
        console.error("Agent error:", e.message);
        batch(() => {
          error.value = {
            code: e.code,
            message: e.message,
          };
          state.value = "error" as AgentState;
        });
        break;
      default:
        break;
    }
  }

  /** Enqueue a PCM16 audio chunk for playback. Transitions state to `"speaking"` on the first chunk. */
  function playAudioChunk(chunk: Uint8Array): void {
    if ((state.value as string) === "error") return;
    if (state.value !== "speaking") {
      state.value = "speaking";
    }
    if (chunk.buffer instanceof ArrayBuffer) {
      conn.voiceIO?.enqueue(chunk.buffer);
    }
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
          state.value = "listening";
        })
        .catch((err: unknown) => {
          console.warn("Audio playback done failed:", err);
        });
    } else {
      state.value = "listening";
    }
  }

  /** Parse a JSON text frame into a ServerMessage, or null if invalid/unknown. */
  function parseTextFrame(data: string): ServerMessage | null {
    try {
      const result = lenientParse(ServerMessageSchema, JSON.parse(data));
      if (!result.ok) {
        if (result.malformed) console.warn("Ignoring invalid server message:", result.error);
        return null;
      }
      return result.data;
    } catch {
      return null;
    }
  }

  /** Try to extract a ReadyConfig from a config message, or null. */
  function parseConfig(
    msg: ServerMessage & { type: "config" },
  ): (ReadyConfig & { sessionId?: string }) | null {
    const { type: _, sessionId, ...config } = msg;
    const parsed = ReadyConfigSchema.safeParse(config);
    if (!parsed.success) {
      console.warn("Unsupported server config:", parsed.error.message);
      return null;
    }
    return sessionId ? { ...parsed.data, sessionId } : parsed.data;
  }

  /**
   * Dispatch an incoming WebSocket message (text or binary).
   *
   * Returns the parsed config if the message is a `config` message,
   * otherwise `null`.
   */
  function handleMessage(
    data: string | ArrayBuffer,
  ): (ReadyConfig & { sessionId?: string }) | null {
    // Binary frame → raw PCM16 TTS audio
    if (data instanceof ArrayBuffer) {
      playAudioChunk(new Uint8Array(data));
      return null;
    }

    const msg = parseTextFrame(data);
    if (!msg) return null;

    if (msg.type === "config") return parseConfig(msg);

    if (msg.type === "audio_done") {
      playAudioDone();
      return null;
    }

    // All other messages are ClientEvent
    handleEvent(msg);
    return null;
  }

  // ─── Connection management ──────────────────────────────────────────────────

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

    const socket = new WS(wsUrl.toString());
    socket.binaryType = "arraybuffer";
    conn.ws = socket;

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
        const config = handleMessage(event.data);
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
              audioDeps.state.value = "error" as AgentState;
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
    if (conn.ws && conn.ws.readyState === WS_OPEN) {
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

  function start(): void {
    batch(() => {
      started.value = true;
      running.value = true;
    });
    connect();
  }

  function toggle(): void {
    if (running.value) {
      cancel();
      disconnect();
    } else {
      connect();
    }
    running.value = !running.value;
  }

  return {
    state,
    messages,
    toolCalls,
    userUtterance,
    agentUtterance,
    error,
    disconnected,
    started,
    running,
    connect,
    cancel,
    resetState,
    reset,
    disconnect,
    start,
    toggle,
    [Symbol.dispose]() {
      disposeEffect();
      disconnect();
    },
  };
}
