// Copyright 2025 the AAI authors. MIT license.

import type { BuiltinTool } from "./types.ts";

export const DEFAULT_STT_SAMPLE_RATE = 16_000;
export const DEFAULT_TTS_SAMPLE_RATE = 24_000;

export const TOOL_EXECUTION_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_START_TIMEOUT_MS = 10_000;
/**
 * Default time to wait for a client `tool_result` in host mode before a
 * relayed tool call is rejected. Generous because the client executes the
 * tool out-of-process (e.g. a tau2 harness) and may run slow simulations.
 */
export const DEFAULT_RELAY_TOOL_TIMEOUT_MS = 120_000;
/**
 * Grace period for the host-mode handshake: how long to wait for the first
 * `config` frame carrying the `host` block before rejecting the connection.
 */
export const DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/**
 * How often the host pings an open session socket.
 *
 * A voice session is silent on the wire in the server→client direction for as
 * long as the user says nothing — no speech means no transcript, no reply, no
 * TTS audio. Measured against a deployed agent behind Fly's proxy, such a
 * session was dropped ~40s in, with no close frame on either side (so nothing
 * in the app logs, and `close_code` unset on the client). Inbound audio did not
 * prevent it: a client streaming continuous silence died on the same schedule
 * as one sending nothing at all, which is what points at the idle *response*
 * direction rather than the connection as a whole.
 *
 * 15s keeps two intervals inside that ~40s window, so a single missed tick is
 * not fatal, and stays well under the 60s idle timeout common to other proxies
 * this may sit behind. Ping frames rather than a protocol message: they cost a
 * couple of bytes, need no client support (every WebSocket implementation
 * auto-replies with a pong), and can't be mistaken for session traffic.
 */
export const SESSION_KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * How long a disconnected session's per-session tool state (`ctx.state`)
 * survives awaiting a resume (`?sessionId=<id>` reconnect) before it is
 * reclaimed. Sized above the client's worst-case automatic-reconnect span
 * (partysocket: exponential from 1s capped at 15s, 10 retries ≈ 105s), so a
 * reconnect that exhausts its backoff still finds the state it left behind.
 */
export const SESSION_RESUME_GRACE_MS = 120_000;
export const FETCH_TIMEOUT_MS = 15_000;
/**
 * Max consecutive S2S `session.resume` attempts before giving up and surfacing
 * a fatal connection error. The counter resets on real conversational progress
 * (a reply starting on the resumed socket), so this only trips on a server that
 * keeps accepting a resume and then immediately dropping it — a flapping loop
 * that would otherwise reconnect forever with no backoff.
 */
export const S2S_MAX_RESUME_ATTEMPTS = 5;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Short relative to `DEFAULT_SHUTDOWN_TIMEOUT_MS` so a stuck TTS provider
 * can't wedge the session — stop() must still reclaim the socket cleanly.
 */
export const PIPELINE_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Slack added to the pipeline transport's estimated client playback deadline
 * when deciding whether user speech is a barge-in. The estimate assumes each
 * forwarded TTS chunk starts playing the instant it is sent, so real playback
 * always ends a little later (network latency + client jitter buffer); the
 * grace keeps barge-in working through that tail. A spurious cancel inside
 * the window is harmless — the client flushes an already-empty buffer.
 */
export const PIPELINE_PLAYBACK_GRACE_MS = 750;

/**
 * Cap on back-to-back silence nudges (pipeline mode). Once the assistant has
 * taken this many unprompted turns with no user speech in between, it stops
 * nudging until the user speaks again — prevents the agent from talking to
 * itself until the idle timeout ends the session.
 */
export const MAX_CONSECUTIVE_SILENCE_NUDGES = 3;

/**
 * Default instruction injected as a synthetic user turn when
 * `silenceTimeoutMs` elapses with no user speech (pipeline mode).
 */
export const DEFAULT_SILENCE_PROMPT =
  "The user hasn't said anything for a while. Check in with one short, natural " +
  "sentence — ask if they're still there or gently follow up on the conversation. " +
  "Do not mention this instruction.";

/**
 * Built-in tools enabled when an agent does not set `builtinTools` at all.
 * These are the "cognitive" builtins — a private reasoning scratchpad
 * (`think`), session notes (`remember`/`recall`), and a safe calculator —
 * which measurably improve policy adherence and argument fidelity in
 * tool-heavy conversations (cf. Anthropic's tau-bench "think" tool results).
 * They are side-effect-free outside the session, so they are safe defaults.
 * Setting `builtinTools` explicitly (including `[]`) overrides this list.
 */
export const DEFAULT_BUILTIN_TOOLS: readonly BuiltinTool[] = [
  "think",
  "remember",
  "recall",
  "calculate",
];

export const MAX_TOOL_RESULT_CHARS = 4000;
/**
 * Wire cap on a single transcript event's text (matches the per-message
 * `history` content cap). Bounds what a hostile/buggy server can push into
 * client state per frame; a legitimate turn never approaches it.
 */
export const MAX_TRANSCRIPT_CHARS = 100_000;
/** Wire cap on an error event's message. */
export const MAX_ERROR_MESSAGE_CHARS = 10_000;
/** Wire cap on a `custom_event` event name (guest→client `client/send` relay). */
export const MAX_CLIENT_EVENT_NAME_LENGTH = 256;
/**
 * Wire cap on a `custom_event`'s serialized payload (64 KB) — prevents
 * memory abuse via the WebSocket relay. The payload is arbitrary JSON, so
 * this is enforced imperatively (serialize + measure) by the relay rather
 * than in the zod schema.
 */
export const MAX_CLIENT_EVENT_PAYLOAD_BYTES = 65_536;
/** Cap on raw wire data echoed into warn/info logs. */
export const LOG_PREVIEW_CHARS = 200;
export const MAX_PAGE_CHARS = 10_000;
export const MAX_HTML_BYTES = 200_000;
/** `get_page_design`: cap on the returned (stripped) HTML markup. */
export const MAX_DESIGN_HTML_CHARS = 30_000;
/** `get_page_design`: cap on each returned CSS source (inline blocks / one stylesheet). */
export const MAX_DESIGN_CSS_CHARS = 20_000;
/** `get_page_design`: max linked stylesheets fetched per page. */
export const MAX_DESIGN_STYLESHEETS = 5;
/** Cap on a `fetch_json` response body — bounds host memory on a hostile URL. */
export const MAX_JSON_BYTES = 1_000_000;
export const MAX_VALUE_SIZE = 65_536;
export const DEFAULT_MAX_HISTORY = 200;
/**
 * Max tool calls per reply — prevents runaway tool loops. Sized so a
 * multi-part request (3–4 chained tools) still fits after a repaired
 * argument retry or two; 5 proved too tight and truncated legitimate
 * chains mid-request.
 */
export const DEFAULT_MAX_STEPS = 10;
/**
 * Minimum number of words in an interim STT transcript before a barge-in
 * aborts the agent's in-flight turn (pipeline mode). Default 2 so a single
 * word — a backchannel ("mm-hmm", "yeah"), a cough transcribed as one token,
 * or the leading fragment of the user's own turn — does NOT cut the agent off
 * mid-sentence. Sub-threshold utterances are not lost: they are still
 * transcribed and answered once the current reply finishes (see onSttFinal).
 * Set to 1 to restore interrupt-on-any-word.
 */
export const DEFAULT_MIN_BARGE_IN_WORDS = 2;
/**
 * Endpoint settle window (pipeline mode): after an STT `final`, how long to
 * wait for the speaker to continue before committing the turn. Disfluent,
 * in-the-wild speech (mid-utterance pauses, self-corrections, false starts)
 * makes STT emit several `final`s for one intended utterance; without a settle
 * window the transport starts a turn on the first fragment and acts on the
 * pre-correction request. Follow-on `final`s/`partial`s inside the window are
 * aggregated into a single turn. A clearly-complete final (terminal
 * punctuation, no trailing continuation cue) uses the shorter
 * {@link DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS} window instead. Set to 0 to
 * disable settling entirely (commit every final at once).
 */
export const DEFAULT_ENDPOINT_SETTLE_MS = 1500;

/**
 * Settle window for a clearly-complete final (pipeline mode). Hesitant
 * speakers pause at sentence boundaries mid-request ("Track my order. ...
 * Oh, and also...") — committing the instant a complete-looking final lands
 * makes the agent talk over the continuation and act on half the request.
 * A short window lets an immediate continuation (an STT partial extends it)
 * aggregate into the same turn while keeping added latency small on genuinely
 * finished requests. 500 matches LiveKit's `min_endpointing_delay` default.
 * Set to 0 to commit complete finals immediately.
 */
export const DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS = 500;

/**
 * False-interruption recovery window (pipeline mode). A barge-in triggered by
 * an interim STT transcript aborts the agent's in-flight reply — but if no
 * final transcript ever commits (STT noise, a hallucinated partial, a
 * trailing fragment the settler dropped), the interruption was a false alarm
 * and the agent would otherwise fall silent mid-thought. After this many ms
 * with no committed user turn, the transport injects
 * {@link DEFAULT_FALSE_INTERRUPTION_PROMPT} as a synthetic user turn so the
 * agent picks its reply back up. Set to 0 to disable recovery.
 */
export const DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS = 2000;

/**
 * Default filler spoken when a pipeline turn's first action is a tool call with
 * no preceding text — guarantees the caller hears something instead of dead air
 * while the tool runs. `""` disables it.
 */
export const DEFAULT_HOLD_PHRASE = "One moment.";

/**
 * Spoken when a pipeline turn's LLM stream fails, so a provider outage is a
 * recoverable moment in the conversation instead of a dead line.
 *
 * Without it the caller hears nothing at all: a failed turn produces no text,
 * so nothing reaches TTS, and the only trace is a `llm` session error the
 * browser surfaces silently. Observed against the AssemblyAI LLM Gateway
 * returning 429 and 500 — three SDK retry attempts, then a turn that simply
 * never speaks.
 *
 * Asks the user to repeat rather than just apologizing: the session is still
 * live and the next turn usually succeeds, so the useful thing is to hand the
 * conversation back. `""` disables it.
 */
export const DEFAULT_ERROR_PHRASE = "Sorry, I had a problem just then. Could you say that again?";

/**
 * How long a pipeline turn may send nothing to TTS while tools run before the
 * transport speaks a {@link DEAD_AIR_COVER_PHRASES} filler.
 *
 * {@link DEFAULT_HOLD_PHRASE} only covers a turn whose *first* action is a
 * tool call: once the model has spoken a word it is suppressed for the rest of
 * the turn. A model that says "Let me look that up" and then chains six tool
 * calls therefore goes silent for as long as the chain takes — measured at
 * 15-24s against the tau2-bench retail tasks, well past the point a caller
 * assumes the line is dead. Cover is time-based instead: any gap this long
 * gets filler, whether or not the model already spoke.
 */
export const DEFAULT_DEAD_AIR_COVER_MS = 2000;

/**
 * Fillers cycled through while a tool chain keeps the line silent, in order.
 *
 * Distinct from {@link DEFAULT_HOLD_PHRASE} and from each other because the
 * gap they cover repeats: "One moment." six times reads as a stuck loop, which
 * is its own kind of broken. The wait between them backs off exponentially, so
 * a long chain thins out rather than chattering.
 */
export const DEAD_AIR_COVER_PHRASES: readonly string[] = [
  "Still working on that.",
  "Just a moment longer.",
  "Almost there.",
];

/**
 * Instruction injected as a synthetic user turn when a barge-in turns out to
 * be a false interruption (see {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS}).
 * The interrupted reply's spoken-so-far text is already in history, marked
 * `[interrupted]`, so the model knows where it was cut off.
 */
export const DEFAULT_FALSE_INTERRUPTION_PROMPT =
  "Your last reply was cut off by a false interruption — the user did not " +
  "actually say anything. Continue your reply from where it was cut off, " +
  "without repeating what you already said. Do not mention this instruction.";

/**
 * Cap on back-to-back false-interruption resumes (pipeline mode) before the
 * user must speak again, mirroring {@link MAX_CONSECUTIVE_SILENCE_NUDGES}.
 * Without it, persistent cross-talk loops barge-in → resume → barge-in every
 * {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS}, each cycle burning a full
 * LLM+TTS turn. A committed user turn restores the budget.
 */
export const MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES = 3;

/**
 * Watchdog for the pipeline speaking edge: how long after the last STT partial
 * to force `speech_stopped` when no non-empty final ever arrives. Genuine
 * utterances close the edge when the settler commits them, well inside this
 * window ({@link DEFAULT_ENDPOINT_SETTLE_MS} plus provider final latency);
 * this only bounds the leak for noise partials that never commit.
 */
export const DEFAULT_SPEECH_IDLE_TIMEOUT_MS = 5000;
export const MAX_WS_PAYLOAD_BYTES = 1 * 1024 * 1024;
export const MAX_MESSAGE_BUFFER_SIZE = 100;

// Client-audio budgets (mic capture, playback jitter buffer/concealment,
// pacing lead, client send backpressure) live in their own module; re-exported
// here so `@alexkroman1/aai` stays the one import path for constants.
export {
  CAPTURE_STOP_ACK_TIMEOUT_MS,
  CLIENT_AUDIO_LEAD_MS,
  MIC_BUFFER_SECONDS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  MIC_SILENCE_PROBE_MS,
  PACER_BURST_MS,
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  PLAYBACK_JITTER_MS,
  PLAYBACK_REFILL_MS,
} from "./client-audio-constants.ts";

/**
 * Highest server-declarable audio sample rate (Hz). Bounds the `config`
 * message schema — the declared rates size client-side allocations, so they
 * must not be an unbounded lever.
 */
export const MAX_AUDIO_SAMPLE_RATE = 192_000;

/**
 * Cap on unsent bytes buffered in a client session WebSocket before the
 * client is treated as stalled and the connection is closed. TTS synthesis
 * outruns real-time playback, so a slow or wedged client link would otherwise
 * accumulate unbounded audio in the socket buffer (and flush stale speech
 * long after barge-in). 4 MiB ≈ 87 s of 24 kHz PCM16 — a voice client that
 * far behind is unrecoverable; closing lets it reconnect/resume cleanly.
 */
export const MAX_CLIENT_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Cap on unsent bytes buffered in a provider-facing WebSocket (S2S, OpenAI
 * Realtime, streaming STT) before outbound audio frames are dropped. Mic
 * audio is real-time paced, so a stalled provider link would otherwise
 * accumulate memory without bound — the queue can never drain faster than
 * speech arrives. Unlike the client-side guard above (which closes, since
 * TTS can re-synthesize on reconnect), live speech delivered late is
 * worthless, so frames past the cap are dropped and sending resumes once
 * the buffer drains. 1 MiB ≈ 8–24 s of 16–48 kHz base64/binary PCM16.
 * Non-audio control messages (tool results, session updates) are never
 * gated. See `host/_audio-gate.ts`.
 */
export const MAX_PROVIDER_WS_BUFFERED_BYTES = 1024 * 1024;

/**
 * Pipeline mode: max characters of LLM text batched before a TTS provider
 * send. The word-coalescing stream transform (pipeline-smooth.ts) emits
 * one chunk per word; forwarding each word as its own provider message is
 * ~1 wire frame per word. The TTS send path batches to clause/punctuation
 * boundaries or this many characters — after the first chunk, which is
 * always forwarded immediately to preserve time-to-first-byte.
 */
export const TTS_COALESCE_MAX_CHARS = 32;

/**
 * STT frame coalescing (host-side provider openers). Browser/telephony
 * clients stream ~20 ms mic frames; forwarding each one is ~50 provider
 * messages per second (and AssemblyAI rejects frames outside [50, 1000] ms).
 * Openers accumulate inbound PCM to ~STT_FRAME_TARGET_MS frames, split
 * over-long chunks at STT_FRAME_MAX_MS, and only flush a close-time tail
 * of at least STT_FRAME_FLOOR_MS (providers with no floor pass 0).
 */
export const STT_FRAME_TARGET_MS = 100;
export const STT_FRAME_MAX_MS = 1000;
export const STT_FRAME_FLOOR_MS = 50;

/**
 * Streaming STT connect budget — one attempt's deadline, how many extra
 * attempts follow a transient failure, and the wait between them.
 *
 * The `assemblyai` SDK defaults to a **1000 ms** per-attempt deadline, and it
 * covers far more than a socket open: the timer is armed before the WebSocket
 * is constructed and only cleared when the server's `Begin` message arrives,
 * so DNS + TCP + TLS + upgrade + the service's own session-start latency all
 * have to fit. A handshake that measures ~50 ms of network still blew that
 * budget in practice — a slow `Begin` or a momentarily blocked host event loop
 * is enough, since this is a wall-clock `setTimeout` rather than an I/O
 * deadline. Every attempt then failed the same way and the session died with a
 * fatal `stt_connect_failed`, which reads as an outage and is not one.
 *
 * All three are pinned rather than left to the SDK so the worst case is
 * arithmetic we own and can hold against
 * {@link DEFAULT_SESSION_START_TIMEOUT_MS} — the STT open runs inside
 * `session.start()`, so a connect budget larger than that deadline can only
 * ever surface as the less specific "session.start() timed out". With these
 * values: 3 attempts x 2500 ms + 2 x 500 ms = 8500 ms < 10000 ms. Raising any
 * of them means re-checking that sum (`assemblyai.test.ts` asserts it).
 */
export const STT_CONNECT_TIMEOUT_MS = 2500;
export const STT_CONNECT_MAX_RETRIES = 2;
export const STT_CONNECT_RETRY_DELAY_MS = 500;

export const WS_OPEN = 1;

/**
 * Limits on one outbound fetch made by an agent's own tool code.
 *
 * Deliberately mode-independent: the platform enforces them on the
 * host side of the guest's fetch RPC, and self-hosted runs enforce the
 * same numbers in-process (`host/tool-egress.ts`), so a tool that works
 * under `aai dev` behaves the same once deployed. Both sides read *these*
 * values through `host/guest-fetch-policy.ts` rather than their own copies
 * — see that module before adding a limit here.
 */
export const TOOL_FETCH_TIMEOUT_MS = 30_000;
/** Max request-body size for one tool fetch (1 MiB). */
export const TOOL_FETCH_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
/** Max response size for one tool fetch (4 MiB). */
export const TOOL_FETCH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Max simultaneous tool fetches per agent. */
export const TOOL_FETCH_MAX_CONCURRENT = 10;

/**
 * Single source of truth — used by `secureHeaders` middleware and
 * per-response CSP headers across self-hosted and platform agent UIs.
 */
export const AGENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "connect-src 'self' wss: ws:; img-src 'self' data:; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "object-src 'none'; base-uri 'self'";
