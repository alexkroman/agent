// Copyright 2026 the AAI authors. MIT license.
/**
 * Backend-independent guest-harness wiring, shared by the sandbox backends
 * (Modal in `modal-sandbox.ts`, the local child process in
 * `subprocess-sandbox.ts`): dialing the harness WebSocket while its
 * server boots, draining guest stdio into host logs, and wrapping a running
 * guest process + dialed socket into the `WarmHarness` shape the pool and
 * slot layers consume.
 *
 * The exit/cleanup semantics here are subtle and were previously duplicated
 * per backend candidate: exit listeners fire exactly once (and immediately
 * for late registrations), cleanup is memoized so concurrent callers wait
 * for the same teardown, and a dropped socket counts as death because the
 * host never redials.
 */

import { createServer } from "node:net";
import { errorMessage } from "@alexkroman1/aai";
import { WebSocket } from "ws";
import type { GuestRpcSchema } from "./rpc-schemas.ts";
import { createRpcConnection, type RpcWebSocket } from "./rpc-transport.ts";
import type { WarmHarness } from "./sandbox-vm.ts";

/** Budget for the harness WebSocket to become dialable after exec. */
const GUEST_DIAL_TIMEOUT_MS = 30_000;

/** Delay between dial attempts while the harness server boots. */
const GUEST_DIAL_RETRY_MS = 250;

/**
 * Ask the OS for a free loopback port, which the subprocess backend's harness
 * binds directly. Racy by nature — the port is released before the guest
 * claims it — which is fine on a single-user dev machine and is why no
 * production backend uses it.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** What every backend needs from its running guest process. */
export type GuestProcLike = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves once the process finishes (any exit path). */
  wait(): Promise<number>;
};

// ── Guest process logging ────────────────────────────────────────────────────

/**
 * Cap on stream bytes logged per sandbox. Guest stack traces are diagnostic
 * gold, but a guest looping on writes must not flood the host's logs — past
 * the cap the stream keeps draining silently (never stop consuming, or the
 * guest wedges on its next write).
 */
const MAX_STREAM_LOG_BYTES = 64 * 1024;

export async function drainProcStream(
  stream: ReadableStream<Uint8Array>,
  label: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let logged = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (logged >= MAX_STREAM_LOG_BYTES) continue; // keep draining, stop logging
      logged += value.byteLength;
      const text = decoder.decode(value, { stream: true }).trimEnd();
      if (text) console.warn(`${label}: ${text}`);
    }
  } catch {
    // Peer died mid-read; process exit handling covers teardown.
  }
}

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
      await new Promise((r) => setTimeout(r, GUEST_DIAL_RETRY_MS));
    }
  }
}

// ── WarmHarness construction ─────────────────────────────────────────────────

/**
 * Wrap a running guest process + dialed harness socket into the WarmHarness
 * shape. `terminate` is the backend's kill switch (Modal `terminate()`,
 * `container stop` + child kill) — best-effort, awaited by cleanup.
 */
export function warmFromGuest(opts: {
  /** Log prefix for guest stdio, e.g. `modal:sb-123`. */
  label: string;
  proc: GuestProcLike;
  terminate: () => Promise<unknown>;
  ws: RpcWebSocket;
  sessionUrl: string;
}): WarmHarness {
  const { label, proc, ws, sessionUrl } = opts;
  void drainProcStream(proc.stdout, `[${label}] stdout`);
  void drainProcStream(proc.stderr, `[${label}] stderr`);

  const conn = createRpcConnection<GuestRpcSchema>(ws);

  const exitListeners: (() => void)[] = [];
  let dead = false;
  const notifyExit = (): void => {
    if (dead) return;
    dead = true;
    for (const cb of exitListeners) {
      try {
        cb();
      } catch {
        // Listener errors must not crash the host
      }
    }
  };
  // The harness process ending — clean exit, sandbox timeout, OOM kill,
  // terminate() — all settle wait(). A dropped socket means the same thing
  // from the host's perspective: this harness is unusable (the host never
  // redials) and its guest self-exits on the orphan timeout.
  proc.wait().then(notifyExit, notifyExit);
  ws.on("close", notifyExit);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    // Memoized: a concurrent second caller must wait for the sandbox to
    // actually be terminated, not return before the first caller finished.
    cleanupPromise ??= (async () => {
      notifyExit();
      try {
        await opts.terminate();
      } catch {
        // Best-effort — the sandbox may already be gone (timeout, crash).
      }
    })();
    return cleanupPromise;
  };

  return {
    conn,
    sessionUrl,
    cleanup,
    alive: () => !dead,
    onExit: (cb) => {
      // A harness can die between spawn resolution and this registration —
      // notifyExit walks the listener list exactly once, so a listener added
      // afterwards would never fire and (for the pool) a dead harness would
      // sit in `ready` unevicted until an acquire skipped it. Fire it now.
      if (dead) {
        try {
          cb();
        } catch {
          // Listener errors must not crash the host
        }
        return;
      }
      exitListeners.push(cb);
    },
    async [Symbol.asyncDispose]() {
      // Best-effort: on a dead guest the notification is dropped, and
      // terminate() may find the sandbox already gone — both fine.
      void conn.sendNotification("shutdown");
      conn.dispose();
      await cleanup().catch(() => undefined);
    },
  };
}
