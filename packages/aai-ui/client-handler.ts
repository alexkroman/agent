// Copyright 2025 the AAI authors. MIT license.

import type { ReadyConfig, ServerMessage } from "@alexkroman1/aai/protocol";
import { ServerMessageSchema } from "@alexkroman1/aai/protocol";
import type { VoiceIO } from "./audio.ts";
import type { AgentState, Message, Reactive, SessionError, ToolCallInfo } from "./types.ts";

type BatchFn = (fn: () => void) => void;

/**
 * Handles server→client messages and updates reactive Preact signals
 * accordingly (state transitions, transcripts, messages, audio playback).
 */
/** @internal Exported for testing only. */
export class ClientHandler {
  #state: Reactive<AgentState>;
  #messages: Reactive<Message[]>;
  #toolCalls: Reactive<ToolCallInfo[]>;
  #userUtterance: Reactive<string | null>;
  #agentUtterance: Reactive<string | null>;
  #error: Reactive<SessionError | null>;
  #voiceIO: () => VoiceIO | null;
  #batch: BatchFn;
  /** Incremented on each turn boundary — stale async callbacks compare against this. */
  #generation = 0;
  constructor(opts: {
    state: Reactive<AgentState>;
    messages: Reactive<Message[]>;
    toolCalls: Reactive<ToolCallInfo[]>;
    userUtterance: Reactive<string | null>;
    agentUtterance: Reactive<string | null>;
    error: Reactive<SessionError | null>;
    voiceIO: () => VoiceIO | null;
    batch: BatchFn;
  }) {
    this.#state = opts.state;
    this.#messages = opts.messages;
    this.#toolCalls = opts.toolCalls;
    this.#userUtterance = opts.userUtterance;
    this.#agentUtterance = opts.agentUtterance;
    this.#error = opts.error;
    this.#voiceIO = opts.voiceIO;
    this.#batch = opts.batch;
  }

  /** Single entry point for all server→client session events. */
  event(e: import("@alexkroman1/aai/protocol").ClientEvent): void {
    switch (e.type) {
      case "speech_started":
        this.#userUtterance.value = "";
        break;
      case "speech_stopped":
        // VAD detected end of speech — processing will follow.
        break;
      case "transcript":
        this.#userUtterance.value = e.text;
        break;
      case "turn":
        this.#generation++;
        this.#batch(() => {
          this.#userUtterance.value = null;
          this.#messages.value = [...this.#messages.value, { role: "user", content: e.text }];
          this.#state.value = "thinking";
        });
        break;
      case "chat_delta":
        this.#agentUtterance.value = this.#agentUtterance.value
          ? `${this.#agentUtterance.value} ${e.text}`
          : e.text;
        break;
      case "chat":
        this.#batch(() => {
          this.#agentUtterance.value = null;
          this.#messages.value = [...this.#messages.value, { role: "assistant", content: e.text }];
        });
        break;
      case "tool_call_start":
        this.#toolCalls.value = [
          ...this.#toolCalls.value,
          {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            args: e.args,
            status: "pending",
            afterMessageIndex: this.#messages.value.length - 1,
          },
        ];
        break;
      case "tool_call_done": {
        const tcs = this.#toolCalls.value;
        const idx = tcs.findIndex((tc) => tc.toolCallId === e.toolCallId);
        if (idx !== -1) {
          const updated = [...tcs];
          const existing = updated[idx];
          if (existing) updated[idx] = { ...existing, status: "done", result: e.result };
          this.#toolCalls.value = updated;
        }
        break;
      }
      case "tts_done":
        // No-audio turns (empty LLM result) still use this event
        // to transition back to listening. Audio turns signal via stream end.
        this.#state.value = "listening";
        break;
      case "cancelled":
        this.#generation++;
        this.#voiceIO()?.flush();
        this.#batch(() => {
          this.#userUtterance.value = null;
          this.#agentUtterance.value = null;
          this.#state.value = "listening";
        });
        break;
      case "reset": {
        this.#generation++;
        this.#voiceIO()?.flush();
        this.#batch(() => {
          this.#messages.value = [];
          this.#toolCalls.value = [];
          this.#userUtterance.value = null;
          this.#agentUtterance.value = null;
          this.#error.value = null;
          this.#state.value = "listening";
        });
        break;
      }
      case "error":
        console.error("Agent error:", e.message);
        this.#batch(() => {
          this.#error.value = {
            code: e.code,
            message: e.message,
          };
          this.#state.value = "error";
        });
        break;
      default:
        break;
    }
  }

  playAudioChunk(chunk: Uint8Array): void {
    if (this.#state.value === "error") return;
    if (this.#state.value !== "speaking") {
      this.#state.value = "speaking";
    }
    this.#voiceIO()?.enqueue(chunk.buffer as ArrayBuffer);
  }

  playAudioDone(): void {
    const gen = this.#generation;
    const io = this.#voiceIO();
    if (io) {
      void io
        .done()
        .then(() => {
          if (this.#generation !== gen) return;
          this.#state.value = "listening";
        })
        .catch((err: unknown) => {
          console.warn("Audio playback done failed:", err);
        });
    } else {
      this.#state.value = "listening";
    }
  }

  /**
   * Dispatch an incoming WebSocket message (text or binary).
   *
   * Returns the parsed config if the message is a `config` message,
   * otherwise `null`.
   */
  handleMessage(data: string | ArrayBuffer): ReadyConfig | null {
    // Binary frame → raw PCM16 TTS audio
    if (data instanceof ArrayBuffer) {
      this.playAudioChunk(new Uint8Array(data));
      return null;
    }

    // Text frame → JSON message
    let msg: ServerMessage;
    try {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(data));
      if (!parsed.success) {
        console.warn("Ignoring invalid server message:", parsed.error.message);
        return null;
      }
      msg = parsed.data;
    } catch {
      return null;
    }

    if (msg.type === "config") {
      const { type: _, ...config } = msg;
      return config as ReadyConfig;
    }

    if (msg.type === "audio_done") {
      this.playAudioDone();
      return null;
    }

    // All other messages are ClientEvent
    this.event(msg);
    return null;
  }
}
