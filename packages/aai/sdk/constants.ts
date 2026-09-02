// Copyright 2025 the AAI authors. MIT license.

import type { BuiltinTool } from "./types.ts";

/** @internal */
export const DEFAULT_STT_SAMPLE_RATE = 16_000;
/** @internal */
export const DEFAULT_TTS_SAMPLE_RATE = 24_000;

/** Wall-clock budget (ms) for one tool `execute` call before it is aborted. */
export const TOOL_EXECUTION_TIMEOUT_MS = 30_000;
/** Deadline (ms) for `session.start()` — providers must be open by then. */
export const DEFAULT_SESSION_START_TIMEOUT_MS = 10_000;
/**
 * Default time to wait for a client `tool_result` in host mode before a
 * relayed tool call is rejected. Generous because the client executes the
 * tool out-of-process (e.g. a tau2 harness) and may run slow simulations.
 *
 * @internal
 */
export const DEFAULT_RELAY_TOOL_TIMEOUT_MS = 120_000;
/**
 * Grace period for the host-mode handshake: how long to wait for the first
 * `config` frame carrying the `host` block before rejecting the connection.
 *
 * @internal
 */
export const DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * Default `idleTimeoutMs` (ms of user silence before the session is closed).
 * Re-armed on every inbound audio frame; `0` or a non-finite value disables
 * the timer entirely.
 */
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
 *
 * @internal
 */
export const SESSION_KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * How long a disconnected session's slot state survives awaiting a resume
 * (`?sessionId=<id>` reconnect) before it is reclaimed. Sized above the client's
 * worst-case automatic-reconnect span (partysocket: exponential from 1s capped
 * at 15s, 10 retries ≈ 105s), so a reconnect that exhausts its backoff still
 * finds the state it left behind.
 *
 * @internal
 */
export const SESSION_RESUME_GRACE_MS = 120_000;
/** Cap on one slot's stored value; `host/session-state-store.ts` says why 1 MiB. @internal */
export const MAX_SESSION_STATE_BYTES = 1_048_576;

/** @internal */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Identity the network builtins (`visit_webpage`, `get_page_design`) present
 * when fetching model-controlled URLs — one definition so every builtin shows
 * the same identity in server logs.
 *
 * @internal
 */
export const TOOL_USER_AGENT =
  "Mozilla/5.0 (compatible; VoiceAgent/1.0; +https://github.com/AssemblyAI/aai)";

/**
 * The `Accept` header the HTML-fetching builtins send.
 *
 * @internal
 */
export const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
/**
 * Max consecutive S2S `session.resume` attempts before giving up and surfacing
 * a fatal connection error. The counter resets on real conversational progress
 * (a reply starting on the resumed socket), so this only trips on a server that
 * keeps accepting a resume and then immediately dropping it — a flapping loop
 * that would otherwise reconnect forever with no backoff.
 *
 * @internal
 */
export const S2S_MAX_RESUME_ATTEMPTS = 5;
/** @internal */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Short relative to `DEFAULT_SHUTDOWN_TIMEOUT_MS` so a stuck TTS provider
 * can't wedge the session — stop() must still reclaim the socket cleanly.
 *
 * @internal
 */
export const PIPELINE_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Cap on back-to-back silence nudges (pipeline mode). Once the assistant has
 * taken this many unprompted turns with no user speech in between, it stops
 * nudging until the user speaks again — prevents the agent from talking to
 * itself until the idle timeout ends the session.
 *
 * @internal
 */
export const MAX_CONSECUTIVE_SILENCE_NUDGES = 3;

/**
 * Default instruction injected as a synthetic user turn when
 * `silenceTimeoutMs` elapses with no user speech (pipeline mode).
 */
export const DEFAULT_SILENCE_PROMPT = `The user hasn't said anything for a while. \
Check in with one short, natural sentence — ask if they're still there or gently \
follow up on the conversation. Do not mention this instruction.`;

/**
 * Built-in tools enabled when an agent does not set `builtinTools` at all —
 * **none**. An agent gets exactly the tools it declares.
 *
 * These were the four "cognitive" builtins: a private reasoning scratchpad
 * (`think`), session notes (`remember`/`recall`), and a safe calculator. They
 * are still available; they are simply opt-in now via
 * `agent({ builtinTools: ["think", ...] })`.
 *
 * The evidence that kept them is worth keeping too, because it argues the
 * other way and a future change should have to answer it. Trimming to
 * `["calculate"]` was tried on a latency theory — each builtin costs an LLM
 * round trip before the agent says anything — and that theory did not survive
 * measurement: on tau2's voice tasks the model never invoked `think` or
 * `calculate` at all, not even when the prompt demanded a calculator for a
 * dollar figure it was about to quote. So an unused builtin costs little, and
 * the one paired comparison available favoured keeping `think` (4/5 correct
 * writes with it against 3/5 without).
 *
 * What that measurement did NOT weigh is the prompt. Declaring builtins makes
 * `hasTools` true, which appends the whole tool preamble, and adds a
 * "Built-in Tool Usage" block on top — for an agent with no tools of its own
 * that is the difference between a ~7.1k and a ~10.9k character system prompt,
 * on a scaffold already carrying three layers that legislate the same
 * behaviours. Defaulting to none makes the tool surface something an agent
 * asks for rather than something it has to notice and switch off.
 */
// `as const satisfies` rather than a bare annotation: the annotation erased the
// type-level fact that this list is EMPTY, which is what let two docs (and the
// scaffold guide shipped to users) go on claiming a four-tool "cognitive set"
// default long after it was removed, with nothing able to check them.
export const DEFAULT_BUILTIN_TOOLS = [] as const satisfies readonly BuiltinTool[];

/**
 * Cap (characters) on a tool result's JSON serialization as seen by the LLM
 * and the client; longer results are trimmed and end with
 * `TOOL_RESULT_TRUNCATION_MARKER`.
 */
export const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Appended to a tool result the framework trimmed at
 * `MAX_TOOL_RESULT_CHARS`, so a model reading
 * it can tell the record is incomplete rather than answering from a partial list
 * as though it were the whole one.
 */
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[truncated]";
/**
 * Wire cap on a single transcript event's text (matches the per-message
 * `history` content cap). Bounds what a hostile/buggy server can push into
 * client state per frame; a legitimate turn never approaches it.
 *
 * @internal
 */
export const MAX_TRANSCRIPT_CHARS = 100_000;
/**
 * Wire cap on an error event's message.
 *
 * @internal
 */
export const MAX_ERROR_MESSAGE_CHARS = 10_000;
/** Wire cap on a `custom_event` event name (`ctx.send` → client). */
export const MAX_CLIENT_EVENT_NAME_LENGTH = 256;
/**
 * Wire cap on a `custom_event`'s serialized payload (64 KB) — prevents
 * memory abuse via `ctx.send`. The payload is arbitrary JSON, so any
 * enforcement is imperative (serialize + measure) rather than in the zod
 * schema.
 */
export const MAX_CLIENT_EVENT_PAYLOAD_BYTES = 65_536;
/**
 * Cap on raw wire data echoed into warn/info logs.
 *
 * @internal
 */
export const LOG_PREVIEW_CHARS = 200;
/** @internal */
export const MAX_PAGE_CHARS = 10_000;
/** @internal */
export const MAX_HTML_BYTES = 200_000;
/**
 * `get_page_design`: cap on the returned (stripped) HTML markup.
 *
 * @internal
 */
export const MAX_DESIGN_HTML_CHARS = 30_000;
/**
 * `get_page_design`: cap on each returned CSS source (inline blocks / one stylesheet).
 *
 * @internal
 */
export const MAX_DESIGN_CSS_CHARS = 20_000;
/**
 * `get_page_design`: max linked stylesheets fetched per page.
 *
 * @internal
 */
export const MAX_DESIGN_STYLESHEETS = 5;
/**
 * Cap on a `fetch_json` response body — bounds host memory on a hostile URL.
 *
 * @internal
 */
export const MAX_JSON_BYTES = 1_000_000;
/** Sliding window of conversation messages retained per session. */
export const DEFAULT_MAX_HISTORY = 200;
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
 * Spoken when the session cannot start at all — a provider failed to open, so
 * there is no conversation to have (pipeline mode).
 *
 * STT and TTS open concurrently and each goes live on its own, so the common
 * case is that TTS connected and STT did not: the agent has a working voice and
 * nothing to listen with. Saying nothing leaves the caller holding a line that
 * sounds connected and never responds — indistinguishable, from their side,
 * from a dead call. One sentence tells them to hang up and try again, which is
 * the only useful thing left to do. Set `startFailurePhrase: ""` to disable.
 */
export const DEFAULT_START_FAILURE_PHRASE = `I am sorry, I am having trouble with \
my connection and cannot hear you. Please hang up and call back.`;

/**
 * Minimum sustained speech before an interim-triggered barge-in aborts the
 * agent's reply (pipeline mode) — measured from the utterance's first partial,
 * LiveKit's `min_interruption_duration` analog. A companion to
 * `DEFAULT_MIN_BARGE_IN_WORDS`: that one asks "is this enough words to be
 * an interruption", this one asks "has it lasted long enough to be speech at
 * all". Committed turns (STT finals) are never gated, so nothing the caller
 * actually said is lost — a gated barge-in only means the agent finishes its
 * sentence first.
 *
 * Non-zero by default because the alternative is worse than the latency: room
 * noise and the tail of the agent's own audio both produce short interim
 * transcripts, and every one of them used to abandon a reply mid-word. Callers
 * heard the agent give up on its own sentences.
 */
export const DEFAULT_INTERRUPTION_MIN_DURATION_MS = 500;

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

/** @internal */
export const MAX_WS_PAYLOAD_BYTES = 1 * 1024 * 1024;
/** @internal */
export const MAX_MESSAGE_BUFFER_SIZE = 100;

// Client-audio budgets (mic capture, playback jitter buffer/concealment,
// pacing lead, client send backpressure) live in their own module; re-exported
// here so `@alexkroman1/aai` stays the one import path for constants.
export {
  CAPTURE_STOP_ACK_TIMEOUT_MS,
  CLIENT_AUDIO_LEAD_MS,
  MAX_PLAYBACK_BUFFERED_MS,
  MIC_BUFFER_SECONDS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  MIC_SILENCE_PROBE_MS,
  PACER_BURST_MS,
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  PLAYBACK_FILL_MS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
} from "./client-audio-constants.ts";
export {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "./endpointing-constants.ts";
// Pipeline/provider tuning (dead-air cover phrases, false-interruption
// recovery, TTS batching, STT framing, provider connect budgets) lives in its
// own module for file-length reasons; re-exported here so `@alexkroman1/aai`
// stays the one import path for constants.
export {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEFAULT_DEAD_AIR_COVER_MS,
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
  MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE,
  PREEMPTIVE_CONFIDENCE_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
  STT_FRAME_FLOOR_MS,
  STT_FRAME_MAX_MS,
  STT_FRAME_TARGET_MS,
  TAIL_RESUME_MIN_UNHEARD_MS,
  TTS_CANCEL_ACK_TIMEOUT_MS,
  TTS_RECONNECT_TIMEOUT_MS,
} from "./pipeline-tuning-constants.ts";
export { HEARD_AUDIO_LAG_MS, PIPELINE_PLAYBACK_GRACE_MS } from "./playback-timing-constants.ts";
// The Voice Agent API's one sample rate, split off for the same file-length reason
// and re-exported for the same import-path one.
export { ASSEMBLYAI_S2S_SAMPLE_RATE } from "./s2s-constants.ts";
export {
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_INACTIVITY_MS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} from "./step-fetch-constants.ts";
// LLM tool-loop defaults (step budget + tool choice) — own module for
// file-length reasons; re-exported so `@alexkroman1/aai` stays the one import
// path for constants.
export { DEFAULT_MAX_STEPS, DEFAULT_TOOL_CHOICE } from "./tool-loop-constants.ts";
// Workflow-upload budgets, split off for the same file-length reason and
// re-exported for the same import-path one.
export {
  MAX_UPLOAD_BYTES_ENV,
  MAX_WORKFLOW_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CLAIM_BATCH,
  UPLOAD_ID_PREFIX,
  UPLOAD_PART_ATTEMPTS,
  UPLOAD_PART_BYTES,
  UPLOAD_PART_CONCURRENCY,
  UPLOAD_RESUME_ATTEMPTS,
  UPLOAD_RESUME_BASE_MS,
  UPLOAD_RESUME_MAX_MS,
  UPLOAD_RETRY_BASE_MS,
  UPLOAD_RETRY_MAX_MS,
  UPLOAD_TOKEN_RE,
} from "./upload-constants.ts";

/**
 * Highest server-declarable audio sample rate (Hz). Bounds the `config`
 * message schema — the declared rates size client-side allocations, so they
 * must not be an unbounded lever.
 *
 * @internal
 */
export const MAX_AUDIO_SAMPLE_RATE = 192_000;

/**
 * Cap on unsent bytes buffered in a client session WebSocket before the
 * client is treated as stalled and the connection is closed. TTS synthesis
 * outruns real-time playback, so a slow or wedged client link would otherwise
 * accumulate unbounded audio in the socket buffer (and flush stale speech
 * long after barge-in). 4 MiB ≈ 87 s of 24 kHz PCM16 — a voice client that
 * far behind is unrecoverable; closing lets it reconnect/resume cleanly.
 *
 * @internal
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
 *
 * @internal
 */
export const MAX_PROVIDER_WS_BUFFERED_BYTES = 1024 * 1024;

/**
 * Default streaming STT `prompt` — deliberately empty: transcription is
 * unbiased in BOTH session modes unless an agent sets `sttPrompt` (the
 * pipeline sends it as `prompt`, S2S as `input.transcription_prompt`).
 *
 * Worth knowing what an agent gives up by leaving it empty. Spoken identifiers
 * are the pipeline's quietest transcription failure: a caller spelling out a
 * confirmation code lands in an *interim* turn, and the formatted final turn
 * can revise those characters away entirely, so the code reaches the LLM
 * missing rather than misheard. The model still has a required tool argument to
 * fill, so it substitutes something plausible — in the worst case the example
 * value from the tool's own schema — and the turn fails with no error anywhere.
 * (Reproduced against FDB-v3: a spelled order ID was dropped from every final
 * turn, and the agent called the tool with the schema's example value.)
 *
 * A prompt only helps when it is specific to the agent's own vocabulary, and
 * showing the spelled→joined form is what makes it stick, e.g.
 * `"Callers read order IDs out character by character: 'K L 4 7 2' is KL472.
 * Never omit a spoken identifier."` A generic version of the same instruction
 * measured no better than none, which is why there is no default here — and
 * why an unrelated prompt is worse than empty: it biases the transcript
 * toward vocabulary the caller never used.
 *
 * **A generic spelled-identifier default was shipped and reverted**, which is
 * the measurement worth keeping: it took an FDB-v3 5-scenario slice from 40% to
 * 80% strict pass, and that win does not transfer to a line whose callers never
 * spell anything, where the same prose steers the transcript toward
 * alphanumeric codes that were never said. Biasing is the agent author's call
 * because only they know the vocabulary; a host-side default can only guess.
 */
export const DEFAULT_STT_PROMPT = "";

/** @internal */
export const WS_OPEN = 1;

/**
 * RFC 6455 Normal Closure — sent on every intentional close. `close()` with no
 * code sends a statusless frame that both ends report as 1005 "No Status
 * Received", making a deliberate teardown look like the peer dropping us.
 *
 * @internal
 */
export const WS_NORMAL_CLOSURE = 1000;

/**
 * The agent UI's Content-Security-Policy.
 *
 * Re-exported so the import path is unchanged; it lives in its own module
 * because it is an HTTP header policy rather than a magic number, and because
 * the argument its `media-src` needs is longer than the header.
 */
export { AGENT_CSP } from "./agent-csp.ts";
