// Copyright 2025 the AAI authors. MIT license.

/**
 * Incoming-message handling for the voice session core.
 *
 * Split out of `session-core.ts`: this module owns the interpretation of
 * server→client frames (audio chunks + JSON {@link SessionEvent}s) and the
 * turn-boundary generation counters, while `session-core.ts` owns the state
 * store and connection lifecycle. The handlers read and mutate session state
 * exclusively through the injected `getSnapshot`/`updateState` deps.
 */

import { safeJsonParse } from "@alexkroman1/aai";
import { DEFAULT_MAX_HISTORY, toArgsRecord } from "@alexkroman1/aai/internal";
import { lenientParse, type SessionEvent, SessionEventSchema } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { SessionStateMachine } from "./session-core-state.ts";
import { bargeIn, type ConnState, type SessionSnapshot, STOPPED } from "./session-core-types.ts";
import type { SessionError } from "./types.ts";

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
 * shared by the initial snapshot, `resetState()`, and `session.reset`.
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
  /** The session's state and error, as one fact — see `session-core-state.ts`. */
  agentState: SessionStateMachine;
  /** Release the microphone/VoiceIO (the session core's `cleanupAudio`). */
  cleanupAudio: () => void;
};

type MessageHandlers = {
  /**
   * Dispatch an incoming WebSocket message.
   *
   * Binary frames carry raw PCM16 audio chunks. Text frames are JSON-encoded
   * {@link SessionEvent} values validated via Zod.
   *
   * Returns the parsed config if the message is a `config` message,
   * otherwise `undefined`.
   */
  handleMessage(data: unknown): SessionConfigMessage | undefined;
  /**
   * Wait for `io`'s playback queue to drain, then transition to `"listening"`
   * — guarded by the same turn-boundary generation the live `audio.completed`
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
  const { getSnapshot, updateState, conn, agentState, cleanupAudio } = deps;

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
      // `THINK`, not `state: "thinking"`: this was the fourth site that should
      // have consulted the fatal latch and did not, so a
      // `user-transcript.committed` arriving behind a fatal error painted a
      // working state over the banner. Declining it is now the machine's, not
      // this caller's, so the site could not have missed it.
      ...agentState.apply({ type: "THINK" }),
    });
  }

  /**
   * The agent-transcript events carry the reply's text so far as a full-replacement
   * snapshot (see the protocol schema), so it renders as the live assistant
   * bubble and only becomes a message when the reply closes. Pipeline mode sends
   * one per piece of speech, so appending each would break a single reply into a
   * message per sentence.
   *
   * Replace rather than merge: a snapshot is not append-only. A pipeline reply's
   * closing snapshot drops the dead-air filler the interim ones carried, so it
   * can be shorter than its predecessor and differ mid-string.
   */
  function handleAgentTranscriptEvent(text: string): void {
    updateState({ agentTranscript: text });
  }

  /**
   * The reply is over (`reply.completed`, or `reply.cancelled` for a barge-in): move
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
   *  is functional (e.g. audio init failed but WebSocket still works).
   *
   *  A FATAL session is exempt, and that exemption is the whole reason the
   *  `fatal` region exists: the host's teardown emits, so the frames that
   *  follow a fatal error are a consequence of it rather than evidence
   *  against it. Recovering on them left the one message that says what to
   *  fix — a missing provider key — on screen for a fraction of a second,
   *  over a session that could no longer hear anyone. */
  function clearRecoveredError(): void {
    // One event for both arms the hand-written version spelled — recover from
    // `error` (to "listening", not "disconnected": the socket is demonstrably
    // open, we are handling a server event) and clear a lingering non-fatal
    // banner from anywhere else — and for the fatal exemption that gated both.
    // See `session-core-state.ts`.
    updateState(agentState.apply({ type: "ACTIVITY" }));
  }

  /**
   * Return to "listening" at a turn boundary — unless the session is over.
   *
   * `reply.completed`, `reply.cancelled` and `session.reset` each wrote
   * `state: "listening"` unconditionally, which is the second half of the same
   * bug `clearRecoveredError` covers: the host's fatal paths all call
   * `terminate()`, and terminating emits `onCancelled()`. So the frame that
   * ANNOUNCES the session's death was also the frame that painted a live-mic
   * state over the error it had just reported.
   *
   * The exemption is not restated here: `LISTEN` is declined while the `fatal`
   * region says so, which is what makes this the whole of the rule rather than
   * one of four sites that had to remember it.
   */
  function toListening(extra: Partial<SessionSnapshot> = {}): void {
    updateState({ ...extra, ...agentState.apply({ type: "LISTEN" }) });
  }

  function handleErrorEvent(e: Extract<SessionEvent, { type: "error.reported" }>): void {
    console.error("Agent error:", e.message);
    // `!== false` rather than a bare read, keeping the defensiveness the branch
    // below already had: an `error.reported` from an older guest that predates
    // the field is treated as fatal, which is the safe direction.
    const error: SessionError = { code: e.code, message: e.message, fatal: e.fatal !== false };
    if (e.fatal === false) {
      // Turn-level failure (e.g. one upload's transcription failed): show
      // the banner but keep the session usable — the server kept running.
      updateState(agentState.apply({ type: "TURN_ERROR", error }));
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
        ...agentState.apply({ type: "FATAL", error }),
        ...STOPPED,
      });
    }
  }

  /** Single entry point for all server->client session events. */
  function handleEvent(e: SessionEvent): void {
    if (e.type !== "error.reported") clearRecoveredError();

    switch (e.type) {
      case "speech.started":
        updateState({ userTranscript: "" });
        break;
      case "speech.stopped":
        // VAD detected end of speech -- processing will follow.
        break;
      case "user-transcript.committed":
        handleUserTranscriptEvent(e.text);
        break;
      case "user-transcript.updated":
        // Live captions while the user is still speaking; the committed turn
        // follows as `user-transcript.committed`, which moves it into `messages`.
        updateState({ userTranscript: e.text });
        break;
      // Both carry the reply's text so far; only the STREAM needs them apart
      // (see the events' own docs), and a caption renders either identically.
      case "agent-transcript.updated":
      case "agent-transcript.committed":
        handleAgentTranscriptEvent(e.text);
        break;
      case "tool.called":
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
      case "tool.completed": {
        const tcs = getSnapshot().toolCalls;
        const idx = tcs.findIndex((tc) => tc.callId === e.toolCallId);
        // One lookup rather than an index check plus a defensive re-read: a
        // miss reads back `undefined` either way, and the second guard was a
        // branch nothing could reach.
        const existing = tcs[idx];
        if (!existing) break;
        const updated = [...tcs];
        updated[idx] = { ...existing, status: "done", result: e.result };
        updateState({ toolCalls: updated });
        break;
      }
      case "reply.completed":
        commitAgentTranscript();
        toListening();
        break;
      case "reply.cancelled":
        bargeIn(conn);
        commitAgentTranscript();
        toListening({ userTranscript: null });
        break;
      case "session.reset": {
        bargeIn(conn);
        // A fatal session keeps its banner AND its conversation:
        // CLEARED_SESSION_STATE nulls `error`, and only a fresh handshake may
        // do that. `RESET` is the machine's half (listening + the banner
        // cleared, or nothing at all); this decides the CONVERSATION, which is
        // the one thing outside the machine's remit.
        const next = agentState.apply({ type: "RESET" });
        updateState(agentState.fatal() ? next : { ...CLEARED_SESSION_STATE, ...next });
        break;
      }
      case "custom.emitted":
        appendCustomEvent(e.event, e.data);
        break;
      case "state.updated":
        // Replace, never append: this is the current value of the agent's
        // state, and only the newest one is meaningful.
        updateState({ agentState: e.state });
        break;
      case "history.restored": {
        // Replace both lists, for the same reason and one more: the server is
        // authoritative about the conversation on a resume, and a frame delivered
        // twice (a second reconnect) must not double it. The ids are minted HERE
        // because they are this client's render keys — both counters keep going
        // from the restored tail, so anything said after the resume cannot
        // collide with something restored.
        messageSeq = 0;
        toolCallSeq = 0;
        const restored = e.messages
          .slice(-MAX_MESSAGES)
          .map((m) => ({ id: ++messageSeq, role: m.role, content: m.content }));
        updateState({
          messages: restored,
          // The anchor arrives as an INDEX into the frame's own messages and is
          // resolved to the id just minted for it. `-1` (before any message, or an
          // anchor the server's own window slid past) stays `-1`, which is what
          // makes the row render ahead of the transcript rather than vanish.
          toolCalls: e.toolCalls.slice(-MAX_MESSAGES).map((tc) => ({
            callId: tc.callId,
            name: tc.name,
            args: toArgsRecord(tc.args),
            status: tc.status,
            ...omitUndefined({ result: tc.result }),
            seq: ++toolCallSeq,
            afterMessageId: restored[tc.afterMessageIndex]?.id ?? -1,
          })),
        });
        break;
      }
      case "error.reported":
        handleErrorEvent(e);
        break;
      case "session.timed-out":
        // The server closes the socket itself; this only marks the close as
        // expected so the automatic reconnect doesn't undo the reclamation.
        conn.retiredByServer = true;
        break;
      default:
        break;
    }
  }

  /** Enqueue a PCM16 audio chunk for playback. Transitions state to `"speaking"` on the first chunk. */
  function playAudioChunk(chunk: ArrayBuffer): void {
    // Binary frames bypass clearRecoveredError on purpose — a straggler chunk
    // must not flip an errored (or error-disconnected) session to "speaking".
    // That used to be a hand-written pair of state reads here; `SPEAK` is
    // simply not a transition `error` offers, and `disconnected` offers it only
    // with no banner up. A declined event leaves the phase where it was, so
    // this stays one write whether it moved or not.
    updateState(agentState.apply({ type: "SPEAK" }));
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
        updateState(agentState.apply({ type: "LISTEN" }));
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
      updateState(agentState.apply({ type: "LISTEN" }));
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
    const parsed = lenientParse(SessionEventSchema, raw);
    if (!parsed.ok) {
      if (parsed.malformed) {
        console.warn("session-core: malformed server message", parsed.error);
      }
      // else: unrecognised type — silently drop (rolling-upgrade tolerance)
      return;
    }
    const msg: SessionEvent = parsed.data;
    if (msg.type === "session.configured") {
      // A completed handshake is a live session, so it supersedes whatever
      // ended the last one — the only frame that may clear the fatal latch
      // (see the `fatal` region in `session-core-state.ts`), since everything
      // else a dying session emits arrives after the error and before any
      // retry. It moves no phase of its own: the socket's `open` already
      // reported `ready`.
      agentState.apply({ type: "HANDSHAKE_COMPLETE" });
      return {
        sampleRate: msg.sampleRate,
        ttsSampleRate: msg.ttsSampleRate,
        sid: msg.sessionId,
      };
    }
    if (msg.type === "audio.completed") {
      playAudioDone();
      return;
    }
    handleEvent(msg);
  }

  return { handleMessage, settleWhenAudioDrained };
}
