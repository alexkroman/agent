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
 * `mountClient()` field to set, and the root is the authoring surface. A custom
 * chrome that bypasses `mountClient()` and opens its own microphone reaches it there
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
  /**
   * Whether the session is OVER.
   *
   * `false` means surface the message and keep the session interactive — a
   * turn-level failure over a server that kept running. `true` means the call
   * is dead and the microphone has been released.
   *
   * Required rather than optional, because the wire always carries it
   * (`error.reported` declares `fatal: z.boolean()`) and a client that cannot
   * tell the two apart has to guess which banner to render. It was dropped one
   * line before reaching here for long enough that this type's own doc, and
   * the reference page generated from it, described a field that did not
   * exist.
   */
  readonly fatal: boolean;
};

/**
 * Options for creating a voice session — the shared field set accepted by
 * both `mountClient()` and `createBrowserSession`. The one difference: `mountClient()`
 * defaults `platformUrl` from `location.href`, while `createBrowserSession`
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
   * Where the client is — e.g. a street address or `"Portland, Oregon"` — sent
   * as `?location=` on every connection attempt (the first, a resume and each
   * reconnect, brokered or not). Location-aware builtins read it: `open_meteo`
   * falls back to it when the model names no place, and `google_places` biases
   * its searches toward it.
   *
   * A string, or a getter asked on EVERY attempt — so a UI whose location can
   * change (a settings field) passes `() => current` and the next reconnect
   * carries the new value without a remount. An empty or `undefined` answer
   * sends none. The server strips control characters and ignores a value
   * longer than 200 characters.
   *
   * Treat it as personal data: like the session id it travels as a query
   * parameter (browsers cannot set WebSocket headers), so it may appear in
   * proxy and access logs.
   */
  location?: string | (() => string | undefined) | undefined;
  /**
   * The phone number of whoever owns this client — sent as `?phone=` on every
   * connection attempt, with the same rules as {@link location}: a string or a
   * getter asked per attempt, trimmed, an empty answer sends none. A tool reads
   * it with `sessionClientPhone(ctx)`, e.g. to text the caller a link.
   *
   * Give it in E.164 form, with the `+` and country code (`"+1 503 555 0123"`):
   * the server strips spaces, dashes, dots and parentheses and then needs a `+`
   * and 8–15 digits. A bare `"5035550123"` is NOT assumed to be North American
   * — it is dropped (the server logs that it was, never the value).
   *
   * The server takes it on the client's word. Personal data: it travels as a
   * query parameter, so it may appear in proxy and access logs.
   */
  phone?: string | (() => string | undefined) | undefined;
  /**
   * The name of THIS client — a device id — sent as `?client=` on every
   * connection attempt, with the same rules as {@link location}: a string or a
   * getter asked per attempt, trimmed, an empty answer sends none.
   *
   * **`"auto"`** has the SDK mint and keep one: this browser's
   * `browserClientId()` — `browser-<32 hex>`, stored in `localStorage` per
   * agent URL (for this tab only where storage is unavailable). It is the id
   * `useInbox()` holds the inbox under too, with a holder id per TAB so two tabs
   * of one browser do not replace each other's inbox socket. Read it back with
   * `useClientId()` or `session.identity.clientId()`. (So `"auto"` itself can
   * never be a client id.)
   *
   * It is the id a tool reads with `sessionClientId(ctx)` and the one a client
   * holds its `WS /inbox?client=` socket open under, so a tool can hand it to a
   * workflow run and the run's `stepNotifyClient` reaches this client AFTER the
   * voice session has ended (a reminder, a finished research job). Send the
   * same id the inbox socket uses, or the run delivers to a client that is not
   * listening.
   *
   * Letters, digits, `-` and `_`, at most 64 characters: the server checks it
   * against the same pattern the inbox uses and ignores one that does not
   * match — the session still opens, it just has no client id.
   *
   * It is also the key of this client's DURABLE conversation: every connection
   * that sends it is seeded with that client's earlier sessions. The server
   * takes it on the client's word and authenticates nothing, so on a server
   * reachable from a network (a LAN-listening dev server, a self-hosted one)
   * the id is the ONLY credential for that history — anyone who can reach the
   * server and knows the id reads what was said. Use an unguessable id.
   */
  client?: string | (() => string | undefined) | undefined;
  /**
   * Open the microphone when the session connects, rather than once the
   * server has configured it, and send what the caller said in between ahead
   * of the live audio — so an opener spoken while the agent is still joining
   * (a handshake, or a sandbox boot on the platform) reaches it instead of
   * being lost. The latest 10 seconds are kept.
   *
   * Default `true`. `false` asks for the microphone only after the server's
   * `config` frame, as before; a UI that wants the permission prompt to
   * follow its own greeting might.
   */
  preConnectAudio?: boolean | undefined;
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
