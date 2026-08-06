// Copyright 2026 the AAI authors. MIT license.
/** Shared helpers for host-side STT/TTS provider openers. */

import { pEvent } from "p-event";
import type WebSocket from "ws";
import { STT_FRAME_MAX_MS, STT_FRAME_TARGET_MS, WS_OPEN } from "../../sdk/constants.ts";
import { errorMessage } from "../../sdk/utils.ts";

/** PCM16 sample rates accepted by providers that stream raw PCM16 LE audio. */
const PCM16_RATES = [
  8000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const satisfies readonly number[];
export type Pcm16Rate = (typeof PCM16_RATES)[number];

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

/**
 * Resolve once the socket opens; reject with the socket error if it fails
 * first. Pass `timeoutMs` to bound a connect that black-holes (no `open`, no
 * `error` — a dropped SYN or a stalled proxy emits neither): mandatory for any
 * open that runs mid-session, where nothing upstream bounds it.
 */
export async function waitForOpen(ws: WebSocket, timeoutMs?: number): Promise<void> {
  // rejects on "error" (p-event's default rejectionEvents)
  await pEvent(ws, "open", timeoutMs === undefined ? {} : { timeout: timeoutMs });
}

/**
 * Construct a raw provider WebSocket, wrapping a constructor throw as a connect
 * error, and bind the pre-connect zero-listener `error` guard.
 *
 * The guard matters: `waitForOpen`'s own `error` listener is removed once it
 * settles, so a later socket `error` with no listener bound is an unhandled
 * `'error'` event — an uncaughtException that crashes the multi-tenant host.
 * This is the one place that invariant now lives; openers call it instead of
 * repeating the try/catch + placeholder-listener dance.
 */
export function createGuardedWs(
  create: () => WebSocket,
  makeConnectError: (msg: string) => Error,
  label: string,
): WebSocket {
  let socket: WebSocket;
  try {
    socket = create();
  } catch (cause) {
    throw makeConnectError(`${label}: failed to create WebSocket: ${errorMessage(cause)}`);
  }
  socket.on("error", () => undefined);
  return socket;
}

/**
 * Detach and politely close a socket, leaving a fresh zero-listener `error`
 * guard behind so an `'error'` emitted while the close handshake is in flight
 * (a TCP reset, a write failure) can't crash the process. `removeAllListeners`
 * on its own strips that guard — the bug this centralizes away from the
 * openers. Pass `terminate` to send a graceful shutdown frame when still open.
 */
export function dropSocket(ws: WebSocket, terminate?: () => void): void {
  ws.removeAllListeners();
  ws.on("error", () => undefined);
  if (terminate && ws.readyState === WS_OPEN) {
    try {
      terminate();
    } catch {
      // Already going away; the close below is what matters.
    }
  }
  try {
    ws.close();
  } catch {
    // Socket already broken — nothing left to release.
  }
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

/** Scaffolding shared by every opener's session — see {@link createSessionShell}. */
export interface SessionShell {
  /** True once `close()` has run (directly or via the abort signal). */
  isClosed(): boolean;
  /** Idempotent close: marks the session closed, then runs teardown with errors swallowed. */
  close(): Promise<void>;
  /** Emit the provider's stream error unless the session is closed. */
  streamError(message: string): void;
  /**
   * Run `emit` unless the session is closed, swallowing any throw from a
   * listener. Use for non-error events (partial/final/audio) fired from inside
   * a raw socket handler, where an escaping throw is an uncaughtException.
   */
  safeEmit(emit: () => void): void;
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
 * latch, an idempotent `close()`, and the standard socket error/close →
 * stream-error mapping. The opener keeps its own typed emitter and passes
 * `emitError` so events stay strongly typed; wire the abort signal after the
 * connection is established via `closeOnAbort(signal, shell.close)`.
 */
export function createSessionShell<E extends Error>(opts: {
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
}): SessionShell {
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
  const streamError = (message: string): void => {
    if (closed) return;
    // emitError fans out to caller-supplied listeners; a throw from one must
    // not escape a socket 'error'/'close' handler (an uncaughtException).
    try {
      opts.emitError(opts.makeStreamError(message));
    } catch {
      // Nothing further to report the error to.
    }
  };
  const safeEmit = (emit: () => void): void => {
    if (closed) return;
    try {
      emit();
    } catch {
      // A listener threw; nothing further to report it to, and it must not
      // escape the raw socket handler that fired this event.
    }
  };
  return {
    isClosed: () => closed,
    close,
    streamError,
    safeEmit,
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
export function createDoneLatch(shell: SessionShell, emitDone: () => void): DoneLatch {
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
