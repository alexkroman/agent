// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared helpers for host-side STT/TTS provider openers. The raw-`ws` socket
 * lifecycle those openers share lives next door in `_socket.ts`.
 */

import type { SttEvents, TtsEvents } from "@alexkroman1/aai/host-internal";
import {
  makeSttError,
  makeTtsError,
  STT_FRAME_MAX_MS,
  STT_FRAME_TARGET_MS,
} from "@alexkroman1/aai/host-internal";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { Emitter, EventsMap, Unsubscribe } from "nanoevents";
import { pEvent } from "p-event";
import type WebSocket from "ws";

/** PCM16 sample rates accepted by providers that stream raw PCM16 LE audio. */
const PCM16_RATES = [
  8000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const satisfies readonly number[];
export type Pcm16Rate = (typeof PCM16_RATES)[number];

/**
 * Read a descriptor's typed options bag.
 *
 * The one narrowing seam every registry goes through: a descriptor carries its
 * options as `Record<string, unknown>` on the wire, and each provider entry
 * knows the shape its own factory declared. Keeping it here means ONE cast
 * rather than one per registry (see the escape-hatch ratchet in CLAUDE.md).
 */
export function options<T>(descriptor: { options: Record<string, unknown> }): T {
  return descriptor.options as unknown as T;
}

/** Assert `rate` is a supported PCM16 rate, else throw via `makeError`. */
export function assertPcm16Rate(
  rate: number,
  label: string,
  makeError: (msg: string) => Error,
): Pcm16Rate {
  if ((PCM16_RATES as readonly number[]).includes(rate)) return rate as Pcm16Rate;
  throw makeError(
    `${label}: unsupported sample rate ${rate}. Supported: ${PCM16_RATES.join(", ")}.`,
  );
}

/**
 * Resolve the session API key from the value the runtime supplied (the agent's
 * own env).
 *
 * This deliberately does NOT fall back to the host's `process.env`. On the
 * managed platform the host process holds the platform's own credentials under
 * exactly the names a tenant descriptor resolves, so a fallback let an agent
 * that declared a provider and supplied no credential of its own silently
 * borrow the platform's. Self-hosted runs opt shell-exported keys in via
 * `withHostCredentialFallback`, which feeds `RuntimeOptions.providerEnv`.
 */
export function requireApiKey(
  explicit: string | undefined,
  envVar: string,
  label: string,
  makeError: (msg: string) => Error,
): string {
  // Falsy check on purpose: the runtime passes "" when the agent env has no key.
  if (!explicit) throw makeError(`${label}: missing API key. Set ${envVar} in the agent env.`);
  return explicit;
}

/** Bound and abort-wire one socket open — see {@link waitForOpen}. */
export interface WaitForOpenOptions {
  /**
   * Reject if the socket has not opened within this many ms. Mandatory for any
   * open with nothing upstream bounding it, which is every one of them —
   * see {@link WS_OPEN_TIMEOUT_MS}.
   */
  timeoutMs?: number | undefined;
  /** Abandon the wait when the session aborts, rejecting with its reason. */
  signal?: AbortSignal | undefined;
}

/**
 * Resolve once the socket opens; reject with the socket error if it fails
 * first, with a timeout if it black-holes (no `open`, no `error` — a dropped
 * SYN or a stalled proxy emits neither), or with the signal's reason if the
 * session aborts first.
 */
export async function waitForOpen(ws: WebSocket, opts: WaitForOpenOptions = {}): Promise<void> {
  // rejects on "error" (p-event's default rejectionEvents)
  await pEvent(ws, "open", omitUndefined({ timeout: opts.timeoutMs, signal: opts.signal }));
}

/** Invoke `close` when `signal` aborts (immediately if already aborted). */
export function closeOnAbort(signal: AbortSignal, close: () => Promise<void> | void): void {
  // Best-effort: a close failure (sync throw or rejection) on an aborting
  // session is not actionable and must not become an unhandled rejection.
  const closeQuietly = (): void => {
    void Promise.resolve()
      .then(close)
      .catch(() => undefined);
  };
  if (signal.aborted) {
    closeQuietly();
    return;
  }
  signal.addEventListener("abort", closeQuietly, { once: true });
}

/** Run `connect`, wrapping any failure as `` `${label}: ${action}: <cause>` ``. */
export async function connectOrThrow<T>(
  label: string,
  makeError: (msg: string) => Error,
  connect: () => T | Promise<T>,
  action = "connect failed",
): Promise<T> {
  try {
    return await connect();
  } catch (cause) {
    throw makeError(`${label}: ${action}: ${errorMessage(cause)}`);
  }
}

/** Coalesces sub-frame PCM chunks into provider-sized frames — see {@link createPcmFrameAccumulator}. */
export interface PcmFrameAccumulator {
  /**
   * Buffer a PCM16 chunk, invoking `send` with one or more coalesced frames
   * as they fill. The chunk is copied — callers may reuse its backing buffer.
   */
  push(pcm: Int16Array): void;
  /**
   * Send any buffered tail of at least `minFlushMs` (dropping a shorter one),
   * then reset. Call on session close so trailing audio isn't lost.
   */
  flush(): void;
}

/**
 * Create a fixed-buffer PCM16 frame accumulator for STT openers.
 *
 * Mic capture arrives as ~20 ms frames (~50 messages/s); forwarding each one
 * costs a provider wire message per frame (and AssemblyAI outright rejects
 * frames outside [50, 1000] ms). The accumulator coalesces inbound PCM into
 * ~{@link STT_FRAME_TARGET_MS} frames (capped at {@link STT_FRAME_MAX_MS}),
 * carrying a sub-target remainder to the next call. A fixed accumulator
 * (vs. reallocating a merged carry per chunk) keeps per-chunk cost to one
 * `set` copy of the new samples.
 *
 * `send` receives a view over the internal buffer valid only for the
 * duration of the call — copy (or encode) before returning, never retain it.
 */
export function createPcmFrameAccumulator(opts: {
  /** PCM16 sample rate (Hz). */
  sampleRate: number;
  /**
   * Minimum tail length (ms) worth flushing on close; shorter tails are
   * dropped. Use the provider's frame floor (e.g. 50 ms for AssemblyAI) or
   * 0 to always flush.
   */
  minFlushMs: number;
  /** Forward one coalesced frame. The view is only valid during the call. */
  send: (frame: Int16Array) => void;
}): PcmFrameAccumulator {
  const { sampleRate, minFlushMs, send } = opts;
  const targetSamples = Math.max(1, Math.round((sampleRate * STT_FRAME_TARGET_MS) / 1000));
  const maxSamples = Math.max(targetSamples, Math.round((sampleRate * STT_FRAME_MAX_MS) / 1000));
  const minFlushSamples = Math.max(1, Math.round((sampleRate * minFlushMs) / 1000));
  const acc = new Int16Array(maxSamples);
  let accLen = 0;
  const sendFrame = (): void => {
    const frame = acc.subarray(0, accLen);
    accLen = 0;
    send(frame);
  };
  return {
    push(pcm: Int16Array): void {
      // Copy into the accumulator, flushing a frame whenever it fills or once
      // the whole chunk is buffered and ≥ the target length has accumulated.
      let offset = 0;
      while (offset < pcm.length) {
        const take = Math.min(maxSamples - accLen, pcm.length - offset);
        acc.set(pcm.subarray(offset, offset + take), accLen);
        accLen += take;
        offset += take;
        if (accLen === maxSamples || (offset === pcm.length && accLen >= targetSamples)) {
          sendFrame();
        }
      }
    },
    flush(): void {
      if (accLen >= minFlushSamples) {
        try {
          sendFrame();
        } catch {
          // socket already closing; nothing to flush
        }
      }
      accLen = 0;
    },
  };
}

/**
 * The `close` an STT session with a frame accumulator owes: flush the tail
 * first, then tear down.
 *
 * Both halves are load-bearing and both were written out per opener. The FLUSH
 * is what stops the last sub-target frame of a session being dropped — the
 * accumulator holds anything shorter than {@link STT_FRAME_TARGET_MS}, which on
 * a short final utterance is the whole thing. The CLOSED CHECK is what stops the
 * abort path flushing onto a socket that is already gone: `closeOnAbort` calls
 * `shell.close` directly, so by the time a caller's own `close()` lands the
 * latch may already be set and `send` would reach a dead socket.
 */
export function closeAfterFlush(
  shell: SessionShell<SttEvents>,
  frames: PcmFrameAccumulator,
): () => Promise<void> {
  return () => {
    if (!shell.isClosed()) frames.flush();
    return shell.close();
  };
}

/** Scaffolding shared by every opener's session — see {@link createSessionShell}. */
export interface SessionShell<Events extends EventsMap> {
  /** True once `close()` has run (directly or via the abort signal). */
  isClosed(): boolean;
  /** Idempotent close: marks the session closed, then runs teardown with errors swallowed. */
  close(): Promise<void>;
  /** Emit the provider's stream error unless the session is closed. */
  streamError(message: string): void;
  /**
   * Emit a session event — the ONLY way an opener should reach its emitter.
   *
   * Owns both halves an opener kept getting wrong: the closed latch (nothing is
   * emitted once the session is gone) and the try/catch (these fire from inside
   * a raw socket handler, where a throw from a downstream listener escapes into
   * Node's `EventEmitter` as an uncaughtException — taking down a multi-tenant
   * host rather than one session). It was `safeEmit(() => emitter.emit(…))`,
   * applied in two openers of seven; the emitter is the shell's now so the
   * remaining five cannot forget.
   */
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void;
  /** Subscribe — the session's own `on`, so no opener re-declares the forward. */
  on<K extends keyof Events>(event: K, fn: Events[K]): Unsubscribe;
  /** Standard socket `error` handler: surfaces the error's message as a stream error. */
  onSocketError(err: unknown): void;
  /**
   * Standard socket `close` handler. Abnormal close codes always surface as
   * stream errors; whether a clean (1000) close does depends on
   * `cleanCloseIsFatal` — see {@link createSessionShell}.
   */
  onSocketClose(code?: number): void;
}

/**
 * Create the session scaffolding every STT/TTS opener repeats: the `closed`
 * latch, an idempotent `close()`, the emit/subscribe surface, and the standard
 * socket error/close → stream-error mapping. The opener hands over its own
 * typed emitter and passes `emitError` so the error variant stays strongly
 * typed (the generic `emit` cannot narrow a constrained `Events["error"]`
 * without a cast); wire the abort signal after the connection is established
 * via `closeOnAbort(signal, shell.close)`.
 */
export function createSessionShell<E extends Error, Events extends EventsMap>(opts: {
  /** The opener's typed emitter. The shell is the only thing that emits on it. */
  emitter: Emitter<Events>;
  /** Build the provider's stream-error variant (e.g. `stt_stream_error`). */
  makeStreamError: (message: string) => E;
  /** Deliver an error event on the session emitter. */
  emitError: (err: E) => void;
  /** Release the underlying connection. Runs at most once. */
  teardown: () => Promise<void> | void;
  /**
   * Whether a clean (1000) close we did not initiate is fatal. Default `false`.
   *
   * Set for continuous **input** streams (STT): the provider closing mid-session
   * — a session cap, an idle cutoff, an upstream deploy — is graceful on the
   * wire but means no further transcripts will ever arrive. Left unset, the
   * session stays nominally open while `sendAudio` discards every frame, so the
   * agent goes permanently deaf with nothing reported to the caller.
   *
   * Leave `false` for **output** streams (TTS), where the provider closing after
   * it has finished sending audio is normal completion, not a failure.
   *
   * A close we initiated ourselves is never fatal either way: `close()` sets the
   * latch first, and `streamError` no-ops once closed. The latch — not the close
   * code — is what distinguishes our intent from the provider's.
   */
  cleanCloseIsFatal?: boolean | undefined;
}): SessionShell<Events> {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await opts.teardown();
    } catch {
      // Caller is tearing down; teardown failures are not actionable.
    }
  };
  /**
   * The one containment point: nothing fans out once the session is closed, and
   * a throw from a caller-supplied listener never escapes the raw socket
   * handler that fired the event (an uncaughtException on a multi-tenant host).
   */
  const contain = (fan: () => void): void => {
    if (closed) return;
    try {
      fan();
    } catch {
      // A listener threw; nothing further to report it to.
    }
  };
  const streamError = (message: string): void => {
    contain(() => opts.emitError(opts.makeStreamError(message)));
  };
  return {
    isClosed: () => closed,
    close,
    streamError,
    emit: (event, ...args) => {
      contain(() => opts.emitter.emit(event, ...args));
    },
    on: (event, fn) => opts.emitter.on(event, fn),
    onSocketError: (err) => streamError(errorMessage(err)),
    onSocketClose: (code) => {
      // 1000 = normal closure; an absent code carries no signal either way.
      // Both are graceful on the wire, so only `cleanCloseIsFatal` decides —
      // an abnormal code is always an error, as before.
      const graceful = code === undefined || code === 1000;
      if (!graceful || opts.cleanCloseIsFatal) streamError(`socket closed ${code ?? "unknown"}`);
    },
  };
}

/**
 * The STT flavour of {@link createSessionShell}: stream errors are
 * `stt_stream_error`, and a clean provider-initiated close is FATAL.
 *
 * That second setting is the one worth having in a single place. It is right
 * for every continuous INPUT stream and wrong for every output one, so
 * restating it per opener is a per-provider chance to get a session-deafening
 * default backwards — see `cleanCloseIsFatal`'s own doc for what that costs.
 */
export function createSttSessionShell(opts: {
  emitter: Emitter<SttEvents>;
  teardown: () => Promise<void> | void;
}): SessionShell<SttEvents> {
  return createSessionShell({
    emitter: opts.emitter,
    makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
    emitError: (err) => opts.emitter.emit("error", err),
    cleanCloseIsFatal: true,
    teardown: opts.teardown,
  });
}

/**
 * The TTS flavour of {@link createSessionShell}: stream errors are
 * `tts_stream_error`, and a clean provider-initiated close is NORMAL
 * COMPLETION — the provider has finished sending the audio it was asked for.
 */
export function createTtsSessionShell(opts: {
  emitter: Emitter<TtsEvents>;
  teardown: () => Promise<void> | void;
}): SessionShell<TtsEvents> {
  return createSessionShell({
    emitter: opts.emitter,
    makeStreamError: (msg) => makeTtsError("tts_stream_error", msg),
    emitError: (err) => opts.emitter.emit("error", err),
    teardown: opts.teardown,
  });
}

/** Per-turn `done` latch — see {@link createDoneLatch}. */
export interface DoneLatch {
  /** True once this turn's `done` has been emitted (until `rearm()`). */
  emitted(): boolean;
  /** Emit `done` at most once per turn, and never after the shell closed. */
  emitOnce(): void;
  /** Reset for a new turn (call when the next turn's text arrives). */
  rearm(): void;
}

/**
 * Create the `done`-once-per-turn latch every TTS opener needs: the pipeline
 * orchestrator advances the turn on `done`, so a duplicate emission — a
 * provider ack racing a barge-in cancel — would advance it mid-reply. The
 * latch keeps that invariant in one place instead of a hand-kept flag per
 * opener.
 */
export function createDoneLatch(shell: SessionShell<TtsEvents>, emitDone: () => void): DoneLatch {
  let emitted = false;
  return {
    emitted: () => emitted,
    emitOnce(): void {
      if (emitted || shell.isClosed()) return;
      emitted = true;
      emitDone();
    },
    rearm(): void {
      emitted = false;
    },
  };
}

/**
 * Pick a provider endpoint: an explicit URL, else the region's, else the
 * vendor default (`undefined` where the vendor SDK's own default is the right
 * answer and a stale copy here would override an SDK path bump).
 *
 * **An explicit URL WINS over `region`**, which is the whole reason this is one
 * function: naming an endpoint is a deliberate act (a staging cluster, an A/B
 * against the default host) and the residency shorthand must not silently
 * overwrite it. The STT opener and the LLM registry each stated that rule in
 * their own near-identical comment, and they differ only in the US case.
 */
export function pickEndpoint(
  explicit: string | undefined,
  region: string | undefined,
  endpoints: { eu: string; default: string },
): string;
export function pickEndpoint(
  explicit: string | undefined,
  region: string | undefined,
  endpoints: { eu: string; default?: string | undefined },
): string | undefined;
export function pickEndpoint(
  explicit: string | undefined,
  region: string | undefined,
  endpoints: { eu: string; default?: string | undefined },
): string | undefined {
  // Length-checked by truthiness on purpose: an empty string is a
  // misconfiguration, not a request for the vendor default.
  if (explicit) return explicit;
  return region === "eu" ? endpoints.eu : endpoints.default;
}
