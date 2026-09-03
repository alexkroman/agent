// Copyright 2026 the AAI authors. MIT license.
/**
 * Backend-independent guest-harness wiring, shared by the sandbox backends
 * (Modal in `modal-sandbox.ts`, the local child process in
 * `subprocess-sandbox.ts`): dialing the harness WebSocket while its
 * server boots, draining guest stdio into host logs, and wrapping a running
 * guest process + dialed socket into the `WarmHarness` shape the studio
 * layers consume.
 *
 * The exit/cleanup semantics here are subtle and were previously duplicated
 * per backend candidate: exit listeners fire exactly once (and immediately
 * for late registrations), cleanup is memoized so concurrent callers wait
 * for the same teardown, and a dropped socket counts as death because the
 * host never redials. They live in `createGuestLiveness` — ONE copy, shared
 * by both handle shapes; a second hand-rolled latch is how they drifted
 * before.
 */

import { createServer } from "node:net";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { LogPage } from "@alexkroman1/aai-runtime";
import { readGuestLogs } from "./agent-logs.ts";
import { MANAGE_REQUEST_TIMEOUT_MS } from "./constants.ts";
import { GUEST_ROUTES, guestHttpUrl, guestWsUrl } from "./guest-routes.ts";
import { createLogger } from "./logger.ts";
import { agentPlatformBaseUrl, agentPublicBaseUrl } from "./public-origin.ts";
import type { GuestRpcSchema } from "./rpc-schemas.ts";
import { createRpcConnection, type RpcWebSocket } from "./rpc-transport.ts";
import type { WarmHarness } from "./sandbox-vm.ts";

// Re-exported rather than moved at every call site: three backends and a
// scenario test take the dial from here, and `guest-dial.ts` is a split for the
// line cap rather than a new boundary anyone asked for.
export { type DialGuest, dialGuest } from "./guest-dial.ts";

const log = createLogger("guest");

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

/**
 * Consume a guest stream chunk-by-chunk to the end. NEVER stops early — a
 * guest blocked on a full pipe wedges on its next write — and swallows
 * mid-read errors (peer death is the exit paths' business). Kept separate from
 * its one caller below so the keep-consuming invariant reads as the rule it
 * is rather than as an incidental loop body.
 */
async function consumeProcStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
    }
  } catch {
    // Peer died mid-read; process exit handling covers teardown.
  }
}

export function drainProcStream(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const decoder = new TextDecoder();
  let logged = 0;
  return consumeProcStream(stream, (value) => {
    if (logged >= MAX_STREAM_LOG_BYTES) return; // keep draining, stop logging
    logged += value.byteLength;
    const text = decoder.decode(value, { stream: true }).trimEnd();
    if (text) log.warn(`${label}: ${text}`);
  });
}

// ── Guest liveness ───────────────────────────────────────────────────────────

/**
 * The exit/teardown semantics every guest handle shares, as one object: a
 * one-shot death latch with fan-out, and a memoized best-effort terminate.
 *
 * Both handle constructors below need exactly this and differ only in what
 * ELSE counts as death (an agent guest has no host socket to drop), so the
 * extra signal is wired by the caller against the returned `kill`.
 */
type GuestLiveness = {
  alive(): boolean;
  /** One-shot exit listener; fires immediately when already dead. */
  onExit(cb: () => void): void;
  /** Mark the guest dead and fan out to the listeners. Idempotent. */
  kill(): void;
  /** Terminate the backend's sandbox. Memoized, best-effort, never throws. */
  cleanup(): Promise<void>;
};

function createGuestLiveness(
  proc: GuestProcLike,
  terminate: () => Promise<unknown>,
): GuestLiveness {
  const exitListeners: (() => void)[] = [];
  let dead = false;
  const fire = (cb: () => void): void => {
    try {
      cb();
    } catch {
      // Listener errors must not crash the host.
    }
  };
  const kill = (): void => {
    if (dead) return;
    dead = true;
    for (const cb of exitListeners) fire(cb);
  };
  // The harness process ending — clean exit, sandbox timeout, OOM kill,
  // terminate() — all settle wait().
  proc.wait().then(kill, kill);

  let cleanupPromise: Promise<void> | null = null;
  return {
    alive: () => !dead,
    onExit(cb) {
      // A harness can die between spawn resolution and this registration —
      // `kill` walks the listener list exactly once, so a listener added
      // afterwards would never fire, so its holder would never learn the
      // harness is unusable. Fire it now.
      if (dead) fire(cb);
      else exitListeners.push(cb);
    },
    kill,
    cleanup() {
      // Memoized: a concurrent second caller must wait for the sandbox to
      // actually be terminated, not return before the first caller finished.
      cleanupPromise ??= (async () => {
        kill();
        try {
          await terminate();
        } catch {
          // Best-effort — the sandbox may already be gone (timeout, crash).
        }
      })();
      return cleanupPromise;
    },
  };
}

// ── Agent-server guests (the HTTP-only contract) ─────────────────────────────

/** Injectable fetch for the health poll and manage surface (tests). */
export type GuestFetch = typeof globalThis.fetch;

/**
 * Start relaying a guest's stdio to the host log. Call this the moment the
 * process exists — BEFORE the readiness poll or the control-channel dial.
 *
 * Every way a guest can fail to come up (a bundle that throws at load, a
 * hash mismatch, a bad env file, an OOM during boot) writes its reason to
 * stderr and exits. Draining only once the guest is *ready* therefore
 * discarded exactly the output that explains a boot failure — while
 * `pollGuestHealth`'s error told the operator to "see its stderr in the host
 * log", where there was nothing to see. Both backends and both modes went
 * through that path, so a deployed agent that would not start reported an
 * exit code and no reason at all.
 *
 * Safe to call once per process: a `ReadableStream` can only be locked by
 * one reader, so the constructors below deliberately no longer drain.
 */
export function startGuestLogging(proc: GuestProcLike, label: string): void {
  void drainProcStream(proc.stdout, `[${label}] stdout`);
  void drainProcStream(proc.stderr, `[${label}] stderr`);
}

/**
 * The exec env selecting agent mode and naming the boot artifacts — one
 * builder so the three backends cannot drift on the key names the guest reads
 * (see aai-guest/harness-agent-mode.ts).
 *
 * Every key here is an `AAI_*` boot parameter, and that is now the rule rather
 * than an observation. `TMPDIR` was the exception: it is a property of the
 * CONTAINER, not of agent mode, so it belongs to `guestExecBaseEnv()`
 * (`guest-exec-env.ts`) — which the two contained backends spread over this env
 * and `subprocess` deliberately does not. It was here because that file was one
 * line from its length cap, and the cost was three copies of one value.
 *
 * `AAI_GUEST_IDLE_EXIT_MS` is forwarded from the SERVER's env when set. The
 * guest documents it as the override for its idle self-exit, but the guest
 * reads `process.env` and only the Modal backend's guests have an ambient
 * environment (the image's) to read it from — the subprocess backend builds
 * a minimal env on purpose, so the knob did nothing there and the one
 * lifecycle timer an operator might want to tune was untunable exactly where
 * it is quickest to observe. Forwarding it here is an explicit boot
 * parameter, not env inheritance, so that rule still holds. The guest owns
 * the parse (an unusable value falls back to its default).
 *
 * `AAI_DEBUG` is forwarded the same way, for a sharper version of the same
 * reason: `debugLoggingEnabled` (aai-runtime/runtime-config.ts) is a module-level
 * `const` read from `process.env` at IMPORT time, while a deployed agent's own env
 * arrives as the boot FILE at `AAI_AGENT_ENV_PATH`, parsed into an object that is
 * never merged into `process.env`. So there was NO WAY AT ALL to switch the guest's
 * debug logging on in a deployed guest — and the guest is where the numbers are:
 * `platform-rpc.ts`'s per-call `{ label, route, traceId, status, elapsedMs }` line
 * is the only decomposition of the guest→platform journal RPC anything measures,
 * and it was dead in production by construction. Read it back off the host log
 * (`startGuestLogging` drains both guest streams) or `aai logs`. Three things
 * before reaching for it: it takes effect at guest BOOT ONLY, that flag being read
 * once at module load, so a resident guest must respawn (redeploy, or idle-exit)
 * before the value is read; it is per REPLICA rather than per slug, arming every
 * agent guest this server goes on to spawn; and `AAI_DEBUG` is the one spelling
 * forwarded — not the `LOG_LEVEL=DEBUG` form `debugLoggingEnabled` also accepts,
 * which is a generic name a hosting stack sets for its own reasons and would make
 * the PLATFORM's log level arm per-message logging inside a tenant's guest, and
 * not `AAI_DEBUG_PARTIALS`, off even under `AAI_DEBUG=1` by the runtime's own
 * design so the turn-level lines stay readable. Its absence is a decision.
 *
 * `AAI_UPLOAD_BROKER_URL` carries the same value as `AAI_PUBLIC_BASE_URL` under a
 * second name on purpose — see the comment at its own line for why one key cannot
 * serve both claims.
 *
 * `AAI_PUBLIC_BASE_URL` is the newest key and the first whose consumer is the
 * BUNDLE'S SDK rather than the harness: the harness hands it straight through as
 * `createRuntime`'s `publicUrl`, and `ctx.workflows.publicWebhookUrl` is what
 * reads it. It is derived HERE — the one place both backends share — for the
 * reason the doc's first line gives, and from {@link agentPublicBaseUrl} rather
 * than from the brokering request, because three of the four spawn paths hold no
 * request at all. Absent when this replica can name no origin; the SDK's own
 * throw is then the report.
 */
export function agentBootEnv(
  opts: {
    /**
     * The agent being spawned. Only `AAI_PUBLIC_BASE_URL` reads it — the guest
     * never learns its own slug otherwise, and does not need to.
     */
    slug: string;
    token: string;
    port: number;
    /**
     * Where the bundle is: a path the spawner wrote into the sandbox, or a
     * URL the guest fetches (see {@link WorkerSource}). Exactly one, because
     * the shape decides — there is no precedence rule for the guest to get
     * wrong, and no way to name a path that was never written.
     */
    bundle: { path: string } | { url: string };
    bundleSha256: string;
    envPath: string;
  },
  /** The server's own environment; injectable for tests. */
  serverEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const idleExitMs = serverEnv.AAI_GUEST_IDLE_EXIT_MS?.trim();
  const debugLogging = serverEnv.AAI_DEBUG?.trim() || undefined;
  const publicBaseUrl = agentPublicBaseUrl(opts.slug, serverEnv);
  const platformBaseUrl = agentPlatformBaseUrl(opts.slug, serverEnv);
  return {
    AAI_GUEST_MODE: "agent",
    AAI_GUEST_TOKEN: opts.token,
    AAI_GUEST_PORT: String(opts.port),
    ...("url" in opts.bundle
      ? { AAI_BUNDLE_URL: opts.bundle.url }
      : { AAI_BUNDLE_PATH: opts.bundle.path }),
    AAI_BUNDLE_SHA256: opts.bundleSha256,
    AAI_AGENT_ENV_PATH: opts.envPath,
    ...(idleExitMs ? { AAI_GUEST_IDLE_EXIT_MS: idleExitMs } : {}),
    // Blank means "not set", normalized to `undefined` above — so this is the
    // `omitUndefined` spelling the three URL keys below argue for, not a
    // truthiness guard (`guard-invariants` rule 22).
    ...omitUndefined({ AAI_DEBUG: debugLogging }),
    // OMITTED rather than set empty when there is no origin to name: the guest
    // trims and drops a blank anyway, but a key that is present and useless is
    // the shape a `publicUrl: ""` bug takes, and a URL a third party cannot
    // reach must not be minted from one. Through `omitUndefined` rather than a
    // truthiness-guarded spread, which is what these three used to be: none of
    // the builders can return `""` (each is `origin ? `${origin}/${slug}`` or
    // undefined), so the two are equivalent here and only one of them is the
    // spelling guard-invariants rule 22 stops the repo re-deriving.
    //
    // THREE keys at (usually) the same value, and the duplication is the point —
    // each is a different CLAIM, and the guest reads them for different jobs:
    //
    // - `AAI_PUBLIC_BASE_URL` — "third parties reach this agent here". A
    //   self-hosted deployment behind a proxy answers this one too. Read as
    //   `publicUrl`, and minted into a webhook URL somebody else dials.
    // - `AAI_UPLOAD_BROKER_URL` — "the thing at this URL serves my upload
    //   bytes", which only a managed platform can say. Reusing the first would
    //   put a self-hosted agent on a byte route nothing serves and 404 every
    //   upload. See `aai/host/server.ts`'s `uploadBroker`.
    // - `AAI_PLATFORM_BASE_URL` — "the platform is DIALABLE here", read by
    //   `resolvePlatformQueue` for run storage, the queue, session state and
    //   upload records. It is the only one of the three that has to be
    //   resolvable from inside the sandbox, which is why it has its own builder
    //   and its own microVM rewrite — see `agentPlatformBaseUrl`.
    //
    // The first two are DELIBERATELY the same value and the third only usually
    // is: in local dev it is derived from this server's own port instead of an
    // observed origin, so a preview works with nothing configured.
    ...omitUndefined({
      AAI_PUBLIC_BASE_URL: publicBaseUrl,
      AAI_UPLOAD_BROKER_URL: publicBaseUrl,
      AAI_PLATFORM_BASE_URL: platformBaseUrl,
    }),
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
  /**
   * The guest's origin (`ws(s)://host:port`) — every guest surface derives
   * from it via GUEST_ROUTES rather than reverse-engineering `sessionUrl`.
   */
  guestOrigin: string;
  /**
   * Live sessions via `GET /manage/status`. NO production caller — kept as
   * the platform's tested client of the status contract (an
   * operator/diagnostic probe; see agent-server-integration.test.ts). Do
   * not wire lifecycle decisions back onto it: the guest owns its own
   * lifecycle. NEVER throws — an unreachable guest or malformed answer
   * reads as 0.
   */
  activeSessions(): Promise<number>;
  /**
   * `POST /manage/drain`: refuse new sessions, exit when empty or at
   * `deadlineMs` (guest-enforced — see aai-guest/harness-agent-mode.ts).
   * THROWS on an unreachable guest: retirement uses the rejection to tell
   * "guest owns its exit now" from "nothing there to drain — terminate".
   */
  drain(deadlineMs?: number): Promise<void>;
  /**
   * This guest's buffered stdout/stderr, after `after` (see agent-logs.ts).
   *
   * NEVER throws — an unreachable or too-old guest reads as an empty page at
   * the caller's own cursor. The caller of this is a user-facing pane, where a
   * failure to reach a guest that simply is not running is not an error to
   * report; `drain` beside it rejects for the opposite reason.
   */
  logs(opts?: { after?: number; limit?: number }): Promise<LogPage>;
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
  proc: GuestProcLike;
  terminate: () => Promise<unknown>;
  origin: string;
  /** The per-sandbox bearer gating the manage surface. */
  token: string;
  fetchFn?: GuestFetch | undefined;
}): AgentServerHandle {
  const { proc, origin, token } = opts;
  const fetchFn = opts.fetchFn ?? fetch;

  // Process exit is the ONLY death signal here — there is no host connection
  // to drop.
  const life = createGuestLiveness(proc, opts.terminate);

  const manage = (
    route: (typeof GUEST_ROUTES)["manageStatus" | "manageDrain"],
    method: string,
    query = "",
  ) =>
    fetchFn(`${guestHttpUrl(origin, route)}${query}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(MANAGE_REQUEST_TIMEOUT_MS),
    });

  return {
    sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session),
    guestOrigin: origin,

    async activeSessions() {
      try {
        const res = await manage(GUEST_ROUTES.manageStatus, "GET");
        if (!res.ok) return 0;
        // Guest-asserted wire data: validate the one field consumed. It may
        // only ever influence this tenant's own reaping and shutdown-drain
        // accounting — a lying guest harms only itself.
        const body = (await res.json()) as { activeSessions?: unknown };
        const count = body.activeSessions;
        if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return 0;
        return count;
      } catch {
        return 0; // unreachable guest = idle guest
      }
    },

    logs(logOpts = {}) {
      return readGuestLogs({ guestOrigin: origin, token, fetchFn, ...logOpts });
    },

    async drain(deadlineMs?: number) {
      const query = deadlineMs === undefined ? "" : `?deadlineMs=${deadlineMs}`;
      const res = await manage(GUEST_ROUTES.manageDrain, "POST", query);
      if (!res.ok) throw new Error(`manage/drain answered HTTP ${res.status}`);
    },

    alive: life.alive,
    onExit: life.onExit,
    shutdown: life.cleanup,
  };
}

// ── WarmHarness construction ─────────────────────────────────────────────────

/**
 * Wrap a running guest process + dialed harness socket into the WarmHarness
 * shape. `terminate` is the backend's kill switch (Modal `terminate()`,
 * subprocess child kill) — best-effort, awaited by cleanup.
 */
export function warmFromGuest(opts: {
  proc: GuestProcLike;
  terminate: () => Promise<unknown>;
  ws: RpcWebSocket;
  /** The guest's origin, e.g. `wss://host:port` — routes derive from it. */
  origin: string;
  /** The per-sandbox bearer this guest was execed with. */
  token: string;
}): WarmHarness {
  const { proc, ws, origin, token } = opts;
  const conn = createRpcConnection<GuestRpcSchema>(ws);

  const life = createGuestLiveness(proc, opts.terminate);
  // A dropped socket means the same thing as a dead process from the host's
  // perspective: this harness is unusable (the host never redials) and its
  // guest self-exits on the orphan timeout.
  ws.on("close", life.kill);

  return {
    conn,
    guestOrigin: origin,
    sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session),
    token,
    cleanup: life.cleanup,
    alive: life.alive,
    onExit: life.onExit,
    async [Symbol.asyncDispose]() {
      // Best-effort: on a dead guest the notification is dropped, and
      // terminate() may find the sandbox already gone — both fine.
      void conn.sendNotification("shutdown");
      conn.dispose();
      await life.cleanup().catch(() => undefined);
    },
  };
}
