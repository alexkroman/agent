// Copyright 2025 the AAI authors. MIT license.

/**
 * Incoming-message handling for the voice session core.
 *
 * Split out of `session-core.ts`: this module owns the interpretation of
 * server→client frames (audio chunks + JSON {@link ServerMessage}s) and the
 * turn-boundary generation counters, while `session-core.ts` owns the state
 * store and connection lifecycle. The handlers read and mutate session state
 * exclusively through the injected `getSnapshot`/`updateState` deps.
 */

import { DEFAULT_MAX_HISTORY, safeJsonParse } from "@alexkroman1/aai";
import {
  type ClientEvent,
  lenientParse,
  type ServerMessage,
  ServerMessageSchema,
} from "@alexkroman1/aai/protocol";
import type { ConnState, SessionSnapshot } from "./session-core-types.ts";

/** Cap on `customEvents` retained in the session snapshot to avoid unbounded growth. */
const MAX_CUSTOM_EVENTS = 200;

/** Cap on `messages` retained in the session snapshot; matches the host-side history cap. */
const MAX_MESSAGES = DEFAULT_MAX_HISTORY;

/** Cap on pre-init audio chunks buffered while `voiceIO` is initializing. ~100 chunks at
 *  typical S2S chunk sizes is well over a second of audio — far longer than init takes
 *  in practice, but bounded against pathological cases (mic-permission stalls). */
const MAX_PREINIT_AUDIO_CHUNKS = 100;

/**
 * Snapshot fields cleared when a session's conversation state is wiped —
 * shared by the initial snapshot, `resetState()`, and the server `reset` event.
 * The empty arrays are safe to share: snapshot collections are never mutated
 * in place, only replaced.
 */
export const CLEARED_SESSION_STATE = {
  messages: [],
  toolCalls: [],
  customEvents: [],
  userTranscript: null,
  agentTranscript: null,
  error: null,
} satisfies Partial<SessionSnapshot>;

function appendCapped<T>(list: readonly T[], item: T, cap: number): T[] {
  if (list.length < cap) return [...list, item];
  const next = list.slice(list.length - cap + 1);
  next.push(item);
  return next;
}

/** Config payload extracted from a `config` server message. */
type SessionConfigMessage = {
  sampleRate: number;
  ttsSampleRate: number;
  sid?: string | undefined;
};

/** Dependencies the message handlers need from the owning session core. */
type MessageHandlerDeps = {
  getSnapshot: () => SessionSnapshot;
  updateState: (partial: Partial<SessionSnapshot>) => void;
  conn: ConnState;
};

type MessageHandlers = {
  /**
   * Dispatch an incoming WebSocket message.
   *
   * Binary frames carry raw PCM16 audio chunks. Text frames are JSON-encoded
   * {@link ServerMessage} values validated via Zod.
   *
   * Returns the parsed config if the message is a `config` message,
   * otherwise `undefined`.
   */
  handleMessage(data: unknown): SessionConfigMessage | undefined;
};

/**
 * Create the server→client message handlers for one session core.
 *
 * Encapsulates the two turn-boundary counters (`handlerGeneration` for
 * discarding stale async audio completions, `customEventSeq` for event
 * dedup) that previously lived as closure locals in `createSessionCore`.
 */
export function createMessageHandlers(deps: MessageHandlerDeps): MessageHandlers {
  const { getSnapshot, updateState, conn } = deps;

  /** Incremented on each turn boundary -- stale async callbacks compare against this. */
  let handlerGeneration = 0;

  /** Monotonically increasing counter for custom events -- used by useEvent to deduplicate. */
  let customEventSeq = 0;

  /** Monotonically increasing counter for chat messages -- stable render keys
   *  and tool-call anchoring that survive the sliding message window. */
  let messageSeq = 0;

  /** Monotonically increasing counter for tool calls -- used by the tool-call
   *  hooks to iterate only the unprocessed tail. */
  let toolCallSeq = 0;

  function appendCustomEvent(name: string, data: unknown): void {
    updateState({
      customEvents: appendCapped(
        getSnapshot().customEvents,
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
        getSnapshot().messages,
        { id: ++messageSeq, role: "user" as const, content: text },
        MAX_MESSAGES,
      ),
      state: "thinking",
    });
  }

  function handleAgentTranscriptEvent(text: string): void {
    updateState({
      agentTranscript: null,
      messages: appendCapped(
        getSnapshot().messages,
        { id: ++messageSeq, role: "assistant" as const, content: text },
        MAX_MESSAGES,
      ),
    });
  }

  /** Single entry point for all server->client session events. */
  function handleEvent(e: ClientEvent): void {
    // Clear error state when a non-error event arrives — proves the session
    // is functional (e.g. audio init failed but WebSocket still works).
    if (getSnapshot().state === "error" && e.type !== "error") {
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
          toolCalls: appendCapped(
            getSnapshot().toolCalls,
            {
              callId: e.toolCallId,
              name: e.toolName,
              args: (e.args ?? {}) as Record<string, unknown>,
              status: "pending",
              seq: ++toolCallSeq,
              afterMessageId: getSnapshot().messages.at(-1)?.id ?? -1,
            },
            MAX_MESSAGES,
          ),
        });
        break;
      case "tool_call_done": {
        const tcs = getSnapshot().toolCalls;
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
        updateState({ ...CLEARED_SESSION_STATE, state: "listening" });
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
    const snap = getSnapshot();
    if (snap.state === "disconnected" && snap.error !== null) return;
    if (snap.state !== "speaking") {
      updateState({ state: "speaking" });
    }
    if (conn.voiceIO) {
      conn.voiceIO.enqueue(chunk.buffer as ArrayBuffer);
    } else if (conn.preInitAudio.length < MAX_PREINIT_AUDIO_CHUNKS) {
      conn.preInitAudio.push(chunk);
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
          updateState({ state: "listening" });
        })
        .catch((err: unknown) => {
          console.warn("Audio playback done failed:", err);
        });
    } else {
      // voiceIO isn't up yet (mic permission / worklet load still pending) and
      // greeting chunks are buffering in preInitAudio. Record the done so
      // initAudioCapture replays it after draining — otherwise a greeting
      // shorter than the worklet's jitter buffer never starts playing. Still
      // transition optimistically (no audio pipeline → nothing to wait for).
      conn.preInitDone = true;
      updateState({ state: "listening" });
    }
  }

  function handleMessage(data: unknown): SessionConfigMessage | undefined {
    if (data instanceof ArrayBuffer) {
      playAudioChunk(new Uint8Array(data));
      return;
    }
    if (typeof data !== "string") {
      console.warn("session-core: non-string, non-binary frame received; dropping");
      return;
    }
    const raw = safeJsonParse(data);
    if (raw === undefined) {
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
    const msg: ServerMessage = parsed.data;
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

  return { handleMessage };
}
