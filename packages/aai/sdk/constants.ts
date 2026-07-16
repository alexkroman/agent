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
export const FETCH_TIMEOUT_MS = 15_000;
/**
 * Max consecutive S2S `session.resume` attempts before giving up and surfacing
 * a fatal connection error. The counter resets on real conversational progress
 * (a reply starting on the resumed socket), so this only trips on a server that
 * keeps accepting a resume and then immediately dropping it — a flapping loop
 * that would otherwise reconnect forever with no backoff.
 */
export const S2S_MAX_RESUME_ATTEMPTS = 5;
export const RUN_CODE_TIMEOUT_MS = 5000;
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

/**
 * TTL for the `remember`/`recall` session-notes KV record. Notes are scoped
 * to one voice session, which is bounded by the idle timeout — a generous TTL
 * only guarantees abandoned sessions' notes don't accumulate in the store.
 */
export const SESSION_NOTES_TTL_MS = 86_400_000;

export const MAX_TOOL_RESULT_CHARS = 4000;
/** Cap on raw wire data echoed into warn/info logs. */
export const LOG_PREVIEW_CHARS = 200;
export const MAX_PAGE_CHARS = 10_000;
export const MAX_HTML_BYTES = 200_000;
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
 * finished requests. Set to 0 to commit complete finals immediately.
 */
export const DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS = 600;
export const MAX_WS_PAYLOAD_BYTES = 1 * 1024 * 1024;
export const MAX_MESSAGE_BUFFER_SIZE = 100;

export const WS_OPEN = 1;

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
