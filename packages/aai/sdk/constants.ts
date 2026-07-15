// Copyright 2025 the AAI authors. MIT license.

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

export const MAX_TOOL_RESULT_CHARS = 4000;
export const MAX_PAGE_CHARS = 10_000;
export const MAX_HTML_BYTES = 200_000;
export const MAX_VALUE_SIZE = 65_536;
export const DEFAULT_MAX_HISTORY = 200;
/** Max tool calls per reply — prevents runaway tool loops. */
export const DEFAULT_MAX_STEPS = 5;
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
