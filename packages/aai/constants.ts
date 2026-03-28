// Copyright 2025 the AAI authors. MIT license.
/**
 * Centralised numeric constants — timeouts, size limits, sample rates.
 *
 * Every magic number that controls a timeout, buffer size, or threshold
 * lives here so the values are discoverable in one place.
 */

// ─── Audio ────────────────────────────────────────────────────────────────

/** Default sample rate for speech-to-text audio in Hz (AssemblyAI). */
export const DEFAULT_STT_SAMPLE_RATE = 16_000;

/** Default sample rate for text-to-speech audio in Hz. */
export const DEFAULT_TTS_SAMPLE_RATE = 24_000;

// ─── Timeouts (ms) ───────────────────────────────────────────────────────

/** Default timeout for agent lifecycle hooks (onConnect, onTurn, etc). */
export const HOOK_TIMEOUT_MS = 5000;

/** Default timeout for tool execution in the worker. */
export const TOOL_EXECUTION_TIMEOUT_MS = 30_000;

/** Timeout for session.start() (S2S connection setup). */
export const DEFAULT_SESSION_START_TIMEOUT_MS = 10_000;

/** S2S session idle timeout before auto-close. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/** Per-fetch timeout for network tools (web_search, visit_webpage, fetch_json). */
export const FETCH_TIMEOUT_MS = 15_000;

/** Timeout for sandboxed run_code execution. */
export const RUN_CODE_TIMEOUT_MS = 5000;

/** Maximum time to wait for sessions to stop during graceful shutdown. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// ─── Size / length limits ────────────────────────────────────────────────

/** Maximum length for tool result strings sent to clients. */
export const MAX_TOOL_RESULT_CHARS = 4000;

/** Maximum chars for webpage text after HTML-to-text conversion. */
export const MAX_PAGE_CHARS = 10_000;

/** Maximum bytes to fetch from an HTML page before conversion. */
export const MAX_HTML_BYTES = 200_000;

/** Maximum value size for KV store entries (bytes). */
export const MAX_VALUE_SIZE = 65_536;

/** Maximum glob pattern length to prevent ReDoS. */
export const MAX_GLOB_PATTERN_LENGTH = 1024;

/** Maximum conversation messages to retain (sliding window). */
export const DEFAULT_MAX_HISTORY = 200;

// ─── Isolate resource limits ─────────────────────────────────────────────

/** Memory limit for run_code isolates (MB). */
export const RUN_CODE_MEMORY_MB = 32;

// ─── Security ───────────────────────────────────────────────────────────

/**
 * Content-Security-Policy applied to agent UI pages (both self-hosted and
 * platform). Single source of truth — used by `secureHeaders` middleware
 * and per-response CSP headers.
 */
export const AGENT_CSP =
  "default-src 'self'; script-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "connect-src 'self' wss: ws:; img-src 'self' data:; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "object-src 'none'; base-uri 'self'";
