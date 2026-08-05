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

import { DEFAULT_MAX_HISTORY, safeJsonParse, toArgsRecord } from "@alexkroman1/aai";
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
  agentState: null,
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
export type SessionConfigMessage = {
  sampleRate: number;
  ttsSampleRate: number;
  sid?: string | undefined;
};

/** Dependencies the message handlers need from the owning session core. */
type MessageHandlerDeps = {
  getSnapshot: () => SessionSnapshot;
  updateState: (partial: Partial<SessionSnapshot>) => void;
  conn: ConnState;
  /** Release the microphone/VoiceIO (the session core's `cleanupAudio`). */
  cleanupAudio: () => void;
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
  /**
   * Wait for `io`'s playback queue to drain, then transition to `"listening"`
   * — guarded by the same turn-boundary generation the live `audio_done`
   * path uses. `initAudioCapture` routes the pre-init greeting replay
   * through this so a barge-in mid-greeting can't be stomped by the
   * replayed completion resolving late.
   */
  settleWhenAudioDrained(io: NonNullable<ConnState["voiceIO"]>): void;
};

/**
 * Create the server→client message handlers for one session core.
 *
 * Encapsulates the per-session dedup counters (`customEventSeq`,
 * `messageSeq`, `toolCallSeq`) that previously lived as closure locals in
 * `createSessionCore`. The turn-boundary epoch is NOT one of them: it lives
 * on `conn` because the session core bumps it on teardown too (see
 * `ConnState.turn`).
 */
export function createMessageHandlers(deps: MessageHandlerDeps): MessageHandlers {
  const { getSnapshot, updateState, conn, cleanupAudio } = deps;

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
    conn.turn.bump();
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

  /**
   * `agent_transcript` carries the reply's text *so far* and is cumulative
   * within a reply (see the protocol schema), so it renders as the live
   * assistant bubble and only becomes a message when the reply closes. Pipeline
   * mode sends one per piece of speech, so appending each would break a single
   * reply into a message per sentence.
   */
  function handleAgentTranscriptEvent(text: string): void {
    updateState({ agentTranscript: text });
  }

  /**
   * The reply is over (`reply_done`, or `cancelled` for a barge-in): move
   * whatever was spoken into the conversation. A cancelled reply still keeps its
   * text — the caller heard that much, and dropping it would leave the
   * transcript claiming the agent never spoke.
   */
  function commitAgentTranscript(): void {
    const text = getSnapshot().agentTranscript;
    if (text === null || text.length === 0) {
      updateState({ agentTranscript: null });
      return;
    }
    updateState({
      agentTranscript: null,
      messages: appendCapped(
        getSnapshot().messages,
        { id: ++messageSeq, role: "assistant" as const, content: text },
        MAX_MESSAGES,
      ),
    });
  }

  /** Clear error state when a non-error event arrives — proves the session
   *  is functional (e.g. audio init failed but WebSocket still works). */
  function clearRecoveredError(): void {
    const snap = getSnapshot();
    if (snap.state === "error") {
      // The socket is demonstrably open (we're handling a server event), so
      // recover to "listening" — "disconnected" would misreport a live session.
      updateState({ state: "listening", error: null });
    } else if (snap.error !== null) {
      // Lingering non-fatal error banner (fatal: false) — the session kept
      // running, so any later activity clears it.
      updateState({ error: null });
    }
  }

  function handleErrorEvent(e: Extract<ClientEvent, { type: "error" }>): void {
    console.error("Agent error:", e.message);
    if (e.fatal === false) {
      // Turn-level failure (e.g. one upload's transcription failed): show
      // the banner but keep the session usable — the server kept running.
      updateState({ error: { code: e.code, message: e.message } });
    } else {
      // Fatal: the session is over — release the microphone too, or the
      // capture worklet keeps streaming into a socket the server may hold
      // open, with the mic indicator lit on a dead session.
      cleanupAudio();
      // Invalidate any audio init still awaiting getUserMedia (same reason
      // the reconnect close-handler bumps the generation): the server may
      // hold the socket open briefly after a fatal frame, and a late mic
      // grant would otherwise pass the same-generation guard, assign a live
      // VoiceIO, and flip the state back to "listening" over this error.
      conn.generation.bump();
      updateState({
        state: "error",
        error: { code: e.code, message: e.message },
        running: false,
        recording: false,
      });
    }
  }

  /** Single entry point for all server->client session events. */
  function handleEvent(e: ClientEvent): void {
    if (e.type !== "error") clearRecoveredError();

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
      case "user_transcript_partial":
        // Live captions while the user is still speaking; the committed turn
        // follows as `user_transcript`, which moves it into `messages`.
        updateState({ userTranscript: e.text });
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
              args: toArgsRecord(e.args),
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
        commitAgentTranscript();
        updateState({ state: "listening" });
        break;
      case "cancelled":
        conn.turn.bump();
        conn.voiceIO?.flush();
        commitAgentTranscript();
        updateState({
          userTranscript: null,
          state: "listening",
        });
        break;
      case "reset": {
        conn.turn.bump();
        conn.voiceIO?.flush();
        updateState({ ...CLEARED_SESSION_STATE, state: "listening" });
        break;
      }
      case "custom_event":
        appendCustomEvent(e.event, e.data);
        break;
      case "agent_state":
        // Replace, never append: this is the current value of the agent's
        // state, and only the newest one is meaningful.
        updateState({ agentState: e.state });
        break;
      case "error":
        handleErrorEvent(e);
        break;
      case "idle_timeout":
        // The server closes the socket itself; this only marks the close as
        // expected so the automatic reconnect doesn't undo the reclamation.
        deps.conn.retiredByServer = true;
        break;
      default:
        break;
    }
  }

  /** Enqueue a PCM16 audio chunk for playback. Transitions state to `"speaking"` on the first chunk. */
  function playAudioChunk(chunk: ArrayBuffer): void {
    const snap = getSnapshot();
    // Binary frames bypass clearRecoveredError on purpose — a straggler chunk
    // must not flip an errored (or error-disconnected) session to "speaking".
    if (snap.state === "error" || (snap.state === "disconnected" && snap.error !== null)) return;
    if (snap.state !== "speaking") {
      updateState({ state: "speaking" });
    }
    if (conn.voiceIO) {
      conn.voiceIO.enqueue(chunk);
    } else if (conn.preInitAudio.length < MAX_PREINIT_AUDIO_CHUNKS) {
      conn.preInitAudio.push(chunk);
    }
  }

  /** See {@link MessageHandlers.settleWhenAudioDrained}. Captures
   *  `conn.turn` so a completion (or failure) that lands after a turn
   *  boundary — including an audio-path teardown — is discarded instead of
   *  overwriting the newer turn's (or the dead session's) state. */
  function settleWhenAudioDrained(io: NonNullable<ConnState["voiceIO"]>): void {
    const gen = conn.turn.current();
    void io
      .done()
      .then(() => {
        if (!conn.turn.isCurrent(gen)) return;
        updateState({ state: "listening" });
      })
      .catch((err: unknown) => {
        console.warn("Audio playback done failed:", err);
      });
  }

  /**
   * Signal that the server has finished sending audio for this turn.
   * Waits for the audio queue to drain, then transitions state to `"listening"`.
   * Uses `conn.turn` to discard stale completions from interrupted turns.
   */
  function playAudioDone(): void {
    const io = conn.voiceIO;
    if (io) {
      settleWhenAudioDrained(io);
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
      playAudioChunk(data);
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

  return { handleMessage, settleWhenAudioDrained };
}
