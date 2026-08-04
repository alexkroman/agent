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
import { sleep } from "./_sleep.ts";
import { GUEST_ROUTES, guestHttpUrl, guestWsUrl } from "./guest-routes.ts";
import type { GuestRpcSchema } from "./rpc-schemas.ts";
import { createRpcConnection, type RpcWebSocket } from "./rpc-transport.ts";
import type { WarmHarness } from "./sandbox-vm.ts";

/** Budget for the harness WebSocket to become dialable after exec. */
const GUEST_DIAL_TIMEOUT_MS = 30_000;

/** Delay between dial attempts while the harness server boots. */
const GUEST_DIAL_RETRY_MS = 250;

/**
 * Budget for an agent-mode guest to answer `/health` after exec. Longer than
 * the dial budget: agent-mode boot LOADS THE BUNDLE before listening (a 200
 * means "ready to serve sessions"), and a large worker's top-level import is
 * part of the wait.
 */
const AGENT_HEALTH_TIMEOUT_MS = 120_000;

/** Per-attempt cap and retry delay for the health poll. */
const AGENT_HEALTH_ATTEMPT_MS = 2000;
const AGENT_HEALTH_RETRY_MS = 250;

/** Per-request cap on the manage-surface probes (status/drain). */
const MANAGE_REQUEST_TIMEOUT_MS = 5000;

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
      await sleep(GUEST_DIAL_RETRY_MS);
    }
  }
}

// ── Agent-server guests (the HTTP-only contract) ─────────────────────────────

/** Injectable fetch for the health poll and manage surface (tests). */
export type GuestFetch = typeof globalThis.fetch;

/**
 * Poll the guest's public `/health` until it answers 200 — agent-mode
 * readiness. The endpoint exists before the guest listens (a Modal tunnel is
 * routable immediately), so refused/reset attempts are the normal boot path.
 *
 * Races the poll against GUEST PROCESS EXIT: a boot failure (hash mismatch,
 * bundle top-level throw, bad env file) exits the guest immediately, and
 * without the race the spawn would burn the whole health deadline blaming
 * the network for what the guest's stderr already said.
 */
export async function pollGuestHealth(
  origin: string,
  proc: GuestProcLike,
  fetchFn: GuestFetch = fetch,
  timeoutMs = AGENT_HEALTH_TIMEOUT_MS,
): Promise<void> {
  const url = guestHttpUrl(origin, GUEST_ROUTES.health);
  const deadline = Date.now() + timeoutMs;
  let exit: { code: number } | null = null;
  void proc.wait().then(
    (code) => {
      exit = { code };
    },
    () => {
      exit = { code: -1 };
    },
  );
  let lastError = "no response";
  for (;;) {
    if (exit !== null) {
      throw new Error(
        `guest exited before ready (exit ${(exit as { code: number }).code}) — see its stderr in the host log`,
      );
    }
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(AGENT_HEALTH_ATTEMPT_MS) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = errorMessage(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(`guest /health not ready after ${timeoutMs}ms: ${lastError}`);
    }
    await sleep(AGENT_HEALTH_RETRY_MS);
  }
}

/**
 * The exec env selecting agent mode and naming the boot artifacts — one
 * builder so the two backends cannot drift on the key names the guest reads
 * (see aai-guest/harness-agent-mode.ts).
 */
export function agentBootEnv(opts: {
  token: string;
  port: number;
  bundlePath: string;
  bundleSha256: string;
  envPath: string;
}): Record<string, string> {
  return {
    AAI_GUEST_MODE: "agent",
    AAI_GUEST_TOKEN: opts.token,
    AAI_GUEST_PORT: String(opts.port),
    AAI_BUNDLE_PATH: opts.bundlePath,
    AAI_BUNDLE_SHA256: opts.bundleSha256,
    AAI_AGENT_ENV_PATH: opts.envPath,
  };
}

/**
 * The host's handle on one AGENT-MODE guest — the whole surviving surface of
 * the platform↔deployed-agent relationship: a session URL to hand to the
 * broker, two token-gated HTTP probes, process liveness, and terminate.
 * There is no RPC connection; the exec convention plus these endpoints ARE
 * the contract (versioned by the guest's reported contractVersion — see
 * aai-guest/limits.ts), frozen per deploy by the harness image pin.
 */
export type AgentServerHandle = {
  /** Public client-session endpoint on the guest's tunnel. */
  sessionUrl: string;
  /** Live sessions via `GET /manage/status`. Throws on an unreachable guest. */
  activeSessions(): Promise<number>;
  /** `POST /manage/drain`: refuse new sessions, exit when the last ends. */
  drain(): Promise<void>;
  /** True while the guest process is alive. */
  alive(): boolean;
  /** One-shot exit listener; fires immediately when already dead. */
  onExit(cb: () => void): void;
  /** Terminate the sandbox (memoized, best-effort). */
  shutdown(): Promise<void>;
};

/**
 * Wrap a running agent-mode guest into its handle. Shares the exit/cleanup
 * semantics of {@link warmFromGuest} minus the socket: process exit is the
 * only death signal (there is no host connection to drop).
 */
export function agentServerFromGuest(opts: {
  label: string;
  proc: GuestProcLike;
  terminate: () => Promise<unknown>;
  origin: string;
  /** The per-sandbox bearer gating the manage surface. */
  token: string;
  fetchFn?: GuestFetch | undefined;
}): AgentServerHandle {
  const { label, proc, origin, token } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  void drainProcStream(proc.stdout, `[${label}] stdout`);
  void drainProcStream(proc.stderr, `[${label}] stderr`);

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
  proc.wait().then(notifyExit, notifyExit);

  const manage = (route: (typeof GUEST_ROUTES)["manageStatus" | "manageDrain"], method: string) =>
    fetchFn(guestHttpUrl(origin, route), {
      method,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(MANAGE_REQUEST_TIMEOUT_MS),
    });

  let cleanupPromise: Promise<void> | null = null;

  return {
    sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session),

    async activeSessions() {
      const res = await manage(GUEST_ROUTES.manageStatus, "GET");
      if (!res.ok) throw new Error(`manage/status answered HTTP ${res.status}`);
      // Guest-asserted wire data: validate the one field consumed. It may
      // only ever influence this tenant's own routing/reaping (see
      // sandbox-scale.ts) — a lying guest harms only itself.
      const body = (await res.json()) as { activeSessions?: unknown };
      const count = body.activeSessions;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        throw new Error("manage/status returned a malformed session count");
      }
      return count;
    },

    async drain() {
      const res = await manage(GUEST_ROUTES.manageDrain, "POST");
      if (!res.ok) throw new Error(`manage/drain answered HTTP ${res.status}`);
    },

    alive: () => !dead,

    onExit: (cb) => {
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

    shutdown() {
      cleanupPromise ??= (async () => {
        notifyExit();
        try {
          await opts.terminate();
        } catch {
          // Best-effort — the sandbox may already be gone (timeout, crash).
        }
      })();
      return cleanupPromise;
    },
  };
}

// ── WarmHarness construction ─────────────────────────────────────────────────

/**
 * Wrap a running guest process + dialed harness socket into the WarmHarness
 * shape. `terminate` is the backend's kill switch (Modal `terminate()`,
 * subprocess child kill) — best-effort, awaited by cleanup.
 */
export function warmFromGuest(opts: {
  /** Log prefix for guest stdio, e.g. `modal:sb-123`. */
  label: string;
  proc: GuestProcLike;
  terminate: () => Promise<unknown>;
  ws: RpcWebSocket;
  /** The guest's origin, e.g. `wss://host:port` — routes derive from it. */
  origin: string;
  /**
   * Backend hook to replace the sandbox's observability tags (Modal's
   * `setTags`). Absent on backends with nothing to tag (subprocess).
   */
  setTags?: ((tags: Record<string, string>) => Promise<void>) | undefined;
}): WarmHarness {
  const { label, proc, ws, origin } = opts;
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
    guestOrigin: origin,
    sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session),
    ...(opts.setTags ? { setTags: opts.setTags } : {}),
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
