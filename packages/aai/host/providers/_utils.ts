// Copyright 2026 the AAI authors. MIT license.
/** Shared helpers for host-side STT/TTS provider openers. */

import type WebSocket from "ws";

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
export function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (err: Error): void => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
}

/** Invoke `close` when `signal` aborts (immediately if already aborted). */
export function closeOnAbort(signal: AbortSignal, close: () => Promise<void> | void): void {
  if (signal.aborted) {
    void close();
    return;
  }
  signal.addEventListener("abort", () => void close(), { once: true });
}
