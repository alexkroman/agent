// Copyright 2026 the AAI authors. MIT license.
/** Shared helpers for host-side STT/TTS provider openers. */

import { pEvent } from "p-event";
import type WebSocket from "ws";
import { errorMessage } from "../../sdk/utils.ts";

/** PCM16 sample rates accepted by providers that stream raw PCM16 LE audio. */
export const PCM16_RATES = [
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

/** Resolve the session API key: explicit value first, then the provider's env var. */
export function requireApiKey(
  explicit: string | undefined,
  envVar: string,
  label: string,
  makeError: (msg: string) => Error,
): string {
  // Falsy check on purpose: the runtime passes "" when the agent env has no
  // key, and that must fall through to the host process env.
  const key = explicit ? explicit : process.env[envVar];
  if (!key) throw makeError(`${label}: missing API key. Set ${envVar} in the agent env.`);
  return key;
}

/** Resolve once the socket opens; reject with the socket error if it fails first. */
export async function waitForOpen(ws: WebSocket): Promise<void> {
  await pEvent(ws, "open"); // rejects on "error" (p-event's default rejectionEvents)
}

/** Invoke `close` when `signal` aborts (immediately if already aborted). */
export function closeOnAbort(signal: AbortSignal, close: () => Promise<void> | void): void {
  if (signal.aborted) {
    void close();
    return;
  }
  signal.addEventListener("abort", () => void close(), { once: true });
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

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}

/** Scaffolding shared by every opener's session — see {@link createSessionShell}. */
export interface SessionShell {
  /** True once `close()` has run (directly or via the abort signal). */
  isClosed(): boolean;
  /** Idempotent close: marks the session closed, then runs teardown with errors swallowed. */
  close(): Promise<void>;
  /** Emit the provider's stream error unless the session is closed. */
  streamError(message: string): void;
  /** Standard socket `error` handler: surfaces the error's message as a stream error. */
  onSocketError(err: unknown): void;
  /** Standard socket `close` handler: non-1000 close codes surface as stream errors. */
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
    opts.emitError(opts.makeStreamError(message));
  };
  return {
    isClosed: () => closed,
    close,
    streamError,
    onSocketError: (err) => streamError(messageOf(err)),
    onSocketClose: (code) => {
      // 1000 = normal closure.
      if (code !== undefined && code !== 1000) streamError(`socket closed ${code}`);
    },
  };
}
