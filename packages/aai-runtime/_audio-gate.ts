// Copyright 2026 the AAI authors. MIT license.
/**
 * Backpressure gate for provider-facing audio sends (S2S, OpenAI Realtime,
 * streaming STT).
 *
 * Mirrors the client-facing guard in `ws-handler.ts`
 * ({@link MAX_CLIENT_WS_BUFFERED_BYTES}) with the opposite remedy: mic audio
 * is real-time paced and loss-tolerant, so while the provider link is stalled
 * the gate DROPS frames instead of closing — the socket buffer stays bounded
 * and stale speech is never delivered late. Only continuous audio frames go
 * through the gate; control messages (tool results, session updates) must
 * never be dropped and bypass it.
 *
 * Logging is transition-based (once on entering the dropping state, once on
 * leaving it) — audio arrives ~50 frames/s, so per-frame logging during a
 * stall would be pure spam.
 */

import { MAX_PROVIDER_WS_BUFFERED_BYTES } from "@alexkroman1/aai/host-internal";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";

/** Per-connection audio backpressure gate — see {@link createAudioSendGate}. */
export interface AudioSendGate {
  /**
   * Should the next audio frame be dropped? Checks the socket's buffered
   * bytes against the cap and logs on transitions into/out of the dropping
   * state. Call once per frame, immediately before sending.
   */
  shouldDrop(): boolean;
}

/**
 * Create an {@link AudioSendGate} over a socket's `bufferedAmount`.
 *
 * `bufferedAmount` is a callback rather than a value so the gate reads the
 * live buffer level per frame. Sockets (or SDK clients) that don't expose a
 * buffered-byte count return `undefined`, which skips the guard entirely —
 * same policy as the client sink in `ws-handler.ts`.
 */
export function createAudioSendGate(opts: {
  /** Unsent bytes queued on the provider socket; `undefined` skips the guard. */
  bufferedAmount: () => number | undefined;
  /** Log-line prefix naming the provider link (e.g. `"S2S"`, `"Soniox STT"`). */
  label: string;
  /** Defaults to the console logger — STT openers carry no logger of their own. */
  log?: Logger | undefined;
}): AudioSendGate {
  const log = opts.log ?? consoleLogger;
  let dropping = false;
  return {
    shouldDrop(): boolean {
      const buffered = opts.bufferedAmount();
      if (buffered === undefined) return false;
      if (buffered > MAX_PROVIDER_WS_BUFFERED_BYTES) {
        if (!dropping) {
          dropping = true;
          log.warn(`${opts.label}: provider audio backlog exceeded; dropping frames`, {
            bufferedBytes: buffered,
            maxBufferedBytes: MAX_PROVIDER_WS_BUFFERED_BYTES,
          });
        }
        return true;
      }
      if (dropping) {
        dropping = false;
        log.debug(`${opts.label}: provider audio backlog drained; resuming sends`, {
          bufferedBytes: buffered,
        });
      }
      return false;
    },
  };
}
