// Copyright 2026 the AAI authors. MIT license.
/**
 * Dialing a spawned harness's control socket, and the retry that covers its boot.
 *
 * Split out of `warm-harness.ts` at the 500-line cap, and it is the seam that
 * file's own doc already named: of the four things it does, this is the one that
 * closes over nothing and is shared by all three backends unchanged. Everything
 * left there is about OWNING a guest — its stdio, its liveness, its handle
 * shapes.
 */

import { errorMessage } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { WebSocket } from "ws";
import type { RpcWebSocket } from "./rpc-transport.ts";

/** Budget for the harness WebSocket to become dialable after exec. */
const GUEST_DIAL_TIMEOUT_MS = 30_000;

/**
 * Delay between dial attempts while the harness server boots — BACKED OFF from
 * 25ms to 250ms rather than fixed.
 *
 * Same pure-added-latency argument as `AGENT_HEALTH_RETRY_MS`
 * (`guest-readiness.ts`): what the loop waits for finishes between attempts, so
 * the cost is the real boot rounded UP to a multiple of the interval — at a flat
 * 250ms, ~125ms on every studio session boot. NOT simply lowered to 25ms the way
 * that poll was: its callers are both local, while this one is dialled by
 * `modal-sandbox.ts` too, where a flat 25ms would make a slow remote boot ~1200
 * attempts across somebody else's tunnel. Backoff takes the win where it exists
 * and settles at the old rate where it does not.
 */
const GUEST_DIAL_RETRY_START_MS = 25;
const GUEST_DIAL_RETRY_MAX_MS = 250;

// ── Guest WebSocket dial ─────────────────────────────────────────────────────

/** How the host reaches a spawned harness — injectable for tests. */
export type DialGuest = (url: string, token: string) => Promise<RpcWebSocket>;

function connectOnce(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`guest WebSocket dial rejected: HTTP ${res.statusCode}`));
    });
  });
}

/**
 * Dial the harness WebSocket, retrying while the harness server boots (the
 * endpoint — a Modal tunnel or a local published port — exists before the
 * guest process listens, so early attempts are refused/reset).
 */
export async function dialGuest(url: string, token: string): Promise<RpcWebSocket> {
  const deadline = Date.now() + GUEST_DIAL_TIMEOUT_MS;
  let retryMs = GUEST_DIAL_RETRY_START_MS;
  for (;;) {
    try {
      return await connectOnce(url, token);
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `guest WebSocket not dialable after ${GUEST_DIAL_TIMEOUT_MS}ms: ${errorMessage(err)}`,
          { cause: err },
        );
      }
      await sleep(retryMs, { unref: true });
      retryMs = Math.min(retryMs * 2, GUEST_DIAL_RETRY_MAX_MS);
    }
  }
}
