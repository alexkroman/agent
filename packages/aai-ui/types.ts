// Copyright 2025 the AAI authors. MIT license.

import type { DefaultToolResult } from "@alexkroman1/aai";
import type { SessionErrorCode } from "@alexkroman1/aai/protocol";

// Client audio/backpressure budgets live in the SDK's constants module,
// next to the host-side halves of the same wire paths (e.g.
// MAX_CLIENT_WS_BUFFERED_BYTES). On `/internal` rather than the SDK's root
// barrel: they are framework budgets with no `agent()` field to set, and the
// root is the authoring surface.
export {
  CAPTURE_STOP_ACK_TIMEOUT_MS,
  CLIENT_AUDIO_LEAD_MS,
  HEARD_AUDIO_LAG_MS,
  MIC_BUFFER_SECONDS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  MIC_SILENCE_PROBE_MS,
  PACER_BURST_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  PLAYBACK_FILL_MS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
} from "@alexkroman1/aai/internal";

/**
 * `getUserMedia` audio constraints for every capture path in this package.
 *
 * Defined once because four copies of this object drifted apart trivially, and
 * the flags are not cosmetic — each one rewrites the signal before STT (and
 * before the sync path's energy VAD) ever sees it:
 *
 * - **`autoGainControl: false`** — AGC continuously retargets level, which
 *   means riding the noise floor up through silence. An energy VAD calibrated
 *   against a moving floor is calibrated against nothing.
 * - **`noiseSuppression: false`** / **`voiceIsolation: false`** — both discard
 *   signal to make speech sound cleaner to a human, and both can gate a quiet
 *   room to *exact* zeros, which is also what a dead microphone looks like
 *   (see `MIC_SILENCE_PROBE_MS`).
 * - **`echoCancellation: true`** — this one stays on. The mic is open while
 *   the agent speaks (barge-in needs it), so without AEC the agent hears
 *   itself and interrupts its own reply.
 *
 * Cast because `voiceIsolation` is newer than TypeScript's DOM lib.
 *
 * On `@alexkroman1/aai-ui/internal` rather than the root barrel, for the same
 * reason as the audio budgets above: it is a framework decision with no
 * `client()` field to set, and the root is the authoring surface. A custom
 * chrome that bypasses `client()` and opens its own microphone reaches it there
 * alongside the providers it also needs.
 */
export const VOICE_CAPTURE_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
} as MediaTrackConstraints;

/**
 * Current state of the voice agent session — the `state` field of
 * {@link SessionSnapshot}, and what a chrome paints its status indicator from.
 *
 * @remarks
 * The seven members, in the order a call passes through them:
 *
 * - `"disconnected"` — no socket. The state before the first `start()` and
 *   after `disconnect()` / `end()`.
 * - `"connecting"` — dialling. Covers the broker lookup and every automatic
 *   reconnect attempt, so a session flickers back through it mid-call.
 * - `"ready"` — the socket is open and the handshake is done, but no turn has
 *   happened yet. **The default chrome paints this with the same live
 *   indicator as `"listening"`**, which is deliberate — to a caller they are
 *   the same "the agent is there" — but they are not the same thing, and a
 *   session can wedge here (see `session-core-handshake.ts`).
 * - `"listening"` — the microphone is open and the agent is waiting for the
 *   caller. Check {@link SessionSnapshot.recording} for whether the mic is
 *   actually live.
 * - `"thinking"` — the caller's turn is committed and the agent is working:
 *   the LLM step, and any tool calls under it.
 * - `"speaking"` — the agent's reply is playing. A caller may still barge in;
 *   the mic stays open throughout.
 * - `"error"` — the session reported a failure. See
 *   {@link SessionSnapshot.error} for what it was. A FATAL error latches here
 *   until the next completed handshake, so a later frame cannot quietly paint
 *   over the banner explaining a dead call.
 *
 * @public
 */
export type AgentState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

/**
 * A chat message exchanged between user and assistant.
 *
 * `role` is `"user" | "assistant"` only — unlike the SDK's `Message`, there
 * is no `"tool"` role here. Tool activity never arrives as messages: it is
 * surfaced via `SessionSnapshot.toolCalls` (or `useEvent` for `ctx.send`
 * events).
 *
 * @public
 */
export type ChatMessage = {
  /**
   * Monotonically increasing, session-unique message id assigned at append
   * time. Stable across snapshot updates and window slides — use it as a
   * render key.
   */
  id: number;
  /** The sender of the message. */
  role: "user" | "assistant";
  /** The text content of the message. */
  content: string;
};

/**
 * Info about a tool call for display in the UI.
 *
 * @public
 */
export type ToolCallInfo = {
  callId: string;
  name: string;
  /**
   * The tool's arguments, as the model sent them.
   *
   * Values are {@link DefaultToolResult} — `any` — for the same reason a tool
   * *result* is: the shape is the author's own Zod schema, which the framework
   * cannot see from here. As `Record<string, unknown>` the ordinary
   * `toolCall.args.url` was a compile error in a client that runs correctly,
   * and the escape hatch agents reached for next (`args as FetchJsonArgs`) is
   * itself an error — TypeScript rejects the cast as insufficiently
   * overlapping. That pair cost two build rounds in one run.
   *
   * Annotate at the read site for real checking:
   * `const { url } = toolCall.args as { url: string }` is still available, and
   * now actually compiles.
   */
  args: Record<string, DefaultToolResult>;
  status: "pending" | "done";
  result?: string | undefined;
  /**
   * Monotonically increasing, session-unique insertion sequence number.
   * Tool calls in a snapshot are always sorted ascending by `seq`.
   */
  seq: number;
  /**
   * `id` of the last {@link ChatMessage} present when this tool call was
   * inserted (`-1` when there were none). The tool call renders immediately
   * after that message; if the anchor message has slid out of the retained
   * window, the tool call renders before all messages.
   */
  afterMessageId: number;
};

/**
 * Re-exported from `@alexkroman1/aai/protocol` (the canonical definition)
 * so client code needs only this package.
 */
export type { SessionErrorCode } from "@alexkroman1/aai/protocol";

/**
 * Error reported by the voice session.
 *
 * @public
 */
export type SessionError = {
  /** The category of the error. */
  readonly code: SessionErrorCode;
  /** A human-readable description of the error. */
  readonly message: string;
};

/**
 * Options for creating a voice session — the shared field set accepted by
 * both `client()` and `createSessionCore`. The one difference: `client()`
 * defaults `platformUrl` from `location.href`, while `createSessionCore`
 * requires it.
 *
 * @public
 */
export type VoiceSessionOptions = {
  /** Base URL of the AAI platform server. */
  platformUrl: string;
  /**
   * Called when the server sends a session ID in the config message.
   * Use this to store the ID (e.g. in localStorage) for reconnection
   * via `resumeSessionId`.
   *
   * Treat session IDs as sensitive: whoever holds one can resume the
   * session and read its replayed history. They travel as a WebSocket
   * query parameter (browsers cannot set WS headers), so they may appear
   * in proxy and server access logs — don't put them in shared URLs.
   */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /**
   * Session ID from a previous connection. When set, the server resumes
   * that session if its per-session state is still within the resume grace
   * window (`SESSION_RESUME_GRACE_MS`), replaying history into the new
   * connection. Sensitive — see {@link onSessionId}.
   */
  resumeSessionId?: string | undefined;
  /**
   * WebSocket constructor override. Primarily useful for testing with a mock
   * WebSocket. When omitted, the session uses a reconnecting WebSocket
   * (partysocket) that retries with exponential backoff after an unexpected
   * close and resumes the session; an injected constructor is used as-is and
   * never reconnects on its own.
   */
  WebSocket?: WebSocketConstructor | undefined;
};

/**
 * Minimal WebSocket constructor type accepted by {@link VoiceSessionOptions}.
 *
 * @public
 */
export type WebSocketConstructor = {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly OPEN: number;
};

/**
 * Theme color overrides for the AAI UI components.
 *
 * @public
 */
export type ClientTheme = {
  /** Background color, also painted on `html`/`body`. Default: `#FBF8F2`. */
  bg?: string;
  /** Primary accent color. Default: `#3F2BC1`. */
  primary?: string;
  /** Main text color. Default: `#1B1A18`. */
  text?: string;
  /** Surface/card color. Default: `#FFFFFF`. */
  surface?: string;
  /** Border color. Default: `#DCD7CC`. */
  border?: string;
};
