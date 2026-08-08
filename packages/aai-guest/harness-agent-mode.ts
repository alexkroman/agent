// Copyright 2026 the AAI authors. MIT license.
/**
 * AGENT-MODE guest support: the "guest is a server" contract.
 *
 * In agent mode (`AAI_GUEST_MODE=agent`) the guest receives EVERYTHING at
 * exec time and holds no host connection at all:
 *
 * - the agent env arrives as a file written into the sandbox before exec
 *   (`AAI_AGENT_ENV_PATH`), and the worker bundle either as a file
 *   (`AAI_BUNDLE_PATH`) or as a signed URL the guest fetches for itself
 *   (`AAI_BUNDLE_URL`) — {@link readAgentBoot} loads it and hash-verifies it
 *   against `AAI_BUNDLE_SHA256` either way;
 * - the platform's remaining needs are a token-gated HTTP surface —
 *   {@link createManageHandler}: `GET /manage/status` (the idle-eviction and
 *   retire-drain probe) and `POST /manage/drain` (stop accepting sessions,
 *   exit when the last one ends);
 * - lifecycle is owned by the guest — {@link createIdleController} self-exits
 *   after an idle window (there is no host socket whose absence could signal
 *   orphanhood) and finishes a drain.
 *
 * Everything the host trusts stays untrusted-guest-safe: the manage surface
 * only reports THIS tenant's own session count, and the bearer only gates
 * who may probe/drain this one sandbox. Like the rest of the harness, this
 * file is bundled into the self-contained guest artifact — node builtins
 * only, zero workspace imports.
 */

import { readFile, rm } from "node:fs/promises";
import type http from "node:http";
import { verifyBearer } from "./harness-auth.ts";
import { bundleSourceOf, readVerifiedBundle } from "./harness-bundle-source.ts";
import { GUEST_CONTRACT_VERSION } from "./limits.ts";

// ---- Boot artifacts ----------------------------------------------------------

export type AgentBoot = {
  /** The worker bundle source (hash-verified). */
  code: string;
  /** The agent's env (`ctx.env` + provider credentials + DATABASE_URL). */
  env: Record<string, string>;
};

/**
 * Read the boot artifacts the spawner delivered into the sandbox.
 *
 * The bundle arrives one of two ways, and the spawner picks by naming one env
 * var or the other: `AAI_BUNDLE_PATH` for a file written into the sandbox
 * before exec, `AAI_BUNDLE_URL` for a time-boxed signed Storage URL the guest
 * FETCHES ITSELF. The second is the platform's path — it stops the ~8 MB
 * bundle from crossing the platform twice on every cold spawn — and it is
 * safe for exactly one reason: the hash below. `AAI_BUNDLE_SHA256` is the
 * agents row's own record of what the deploy published, so the guest trusts
 * the HASH and never the transport, the URL, or whoever served it. A mismatch
 * is a hard boot failure (exit, respawn), never a silently different agent.
 *
 * The env file is best-effort deleted after reading so the secrets live in
 * process memory rather than on the sandbox disk.
 */
export async function readAgentBoot(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentBoot> {
  const expected = env.AAI_BUNDLE_SHA256;
  const source = bundleSourceOf(env.AAI_BUNDLE_URL, env.AAI_BUNDLE_PATH);
  if (!(expected && source)) {
    throw new Error("agent mode requires AAI_BUNDLE_SHA256 and one of AAI_BUNDLE_PATH/_URL");
  }
  // Agent mode requires the hash for BOTH shapes (the shared reader only
  // forces it for a URL): a deployed agent's bundle is named by the agents
  // row's `worker_hash`, so there is never a reason to load one unverified.
  const code = await readVerifiedBundle(source, expected);
  return { code, env: await readAgentEnvFile(env.AAI_AGENT_ENV_PATH) };
}

/**
 * The agent's env, best-effort deleted after reading so the secrets live in
 * process memory rather than on the sandbox disk. An absent path is a legal
 * boot with an empty env; a malformed file is not.
 */
async function readAgentEnvFile(envPath: string | undefined): Promise<Record<string, string>> {
  if (!envPath) return {};
  const raw = JSON.parse(await readFile(envPath, "utf-8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("agent env file must contain a JSON object");
  }
  const agentEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new Error(`agent env value for ${key} must be a string`);
    }
    agentEnv[key] = value;
  }
  await rm(envPath, { force: true }).catch(() => undefined);
  return agentEnv;
}

// ---- Manage surface ----------------------------------------------------------

/** Paths of the token-gated management surface. */
export const MANAGE_STATUS_PATH = "/manage/status";
export const MANAGE_DRAIN_PATH = "/manage/drain";

export type ManageDeps = {
  /** The per-sandbox bearer (AAI_GUEST_TOKEN) gating this surface. */
  token: string;
  /** Live client-session count (the harness state's counter). */
  activeSessions: () => number;
  /** True once a drain was requested. */
  isDraining: () => boolean;
  /**
   * Request a drain: refuse new sessions, exit when the last one ends —
   * or at `deadlineMs` from now regardless (the host's retire budget; a
   * drained guest is superseded code, so it must not outlive one long
   * call indefinitely). Absent deadline: drain until empty.
   */
  startDrain: (deadlineMs?: number) => void;
};

/**
 * The drain deadline off the request's query (`?deadlineMs=600000`). A query
 * param rather than a body: the server's request hook hands over a
 * query-stripped path, so the raw `req.url` is the one place the value
 * rides, and a number in a query needs no body reader, no size cap, and no
 * JSON parsing. Absent/malformed reads as "drain until empty".
 */
function drainDeadlineMs(req: http.IncomingMessage): number | undefined {
  const raw = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("deadlineMs");
  const ms = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The `request` hook serving `/manage/*`. Claims every `/manage` path
 * (unauthenticated ones with a 401 — the tunnel URL is public, the bearer is
 * what keeps this from being an open door), leaves everything else to the
 * server's own routing.
 */
export function createManageHandler(
  deps: ManageDeps,
): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  return (req, res, url, method) => {
    if (!url.startsWith("/manage/")) return false;
    if (!verifyBearer(req.headers.authorization, deps.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (method === "GET" && url === MANAGE_STATUS_PATH) {
      sendJson(res, 200, {
        activeSessions: deps.activeSessions(),
        draining: deps.isDraining(),
        contractVersion: GUEST_CONTRACT_VERSION,
      });
      return true;
    }
    if (method === "POST" && url === MANAGE_DRAIN_PATH) {
      deps.startDrain(drainDeadlineMs(req));
      sendJson(res, 200, { ok: true, draining: true });
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  };
}

// ---- Idle / drain lifecycle ---------------------------------------------------

export type IdleController = {
  isDraining: () => boolean;
  startDrain: (deadlineMs?: number) => void;
  /** Stop the poll timer (tests). */
  stop: () => void;
};

/**
 * Guest-owned lifecycle: exit 0 once idle past `idleExitMs` (0 disables); a
 * requested drain exits as soon as the sessions hit zero, or at the drain's
 * own deadline regardless (retirement is fire-and-forget host-side — the
 * guest enforces the budget on itself). This replaces the control-channel
 * orphan timeout — an agent-mode guest has no host socket, so "nobody needs
 * me" is measured by its own session count.
 */
export function createIdleController(opts: {
  activeSessions: () => number;
  idleExitMs: number;
  pollMs: number;
  /** Injectable for tests. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  now?: () => number;
}): IdleController {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? Date.now;
  let draining = false;
  let drainDeadline = Number.POSITIVE_INFINITY;
  let lastBusy = now();

  const tick = (): void => {
    if (draining && now() >= drainDeadline) {
      console.error("agent guest drain deadline reached; exiting with sessions live");
      exit(0);
      return;
    }
    if (opts.activeSessions() > 0) {
      lastBusy = now();
      return;
    }
    if (draining) {
      console.error("agent guest drained: no live sessions; exiting");
      exit(0);
      return;
    }
    if (opts.idleExitMs > 0 && now() - lastBusy > opts.idleExitMs) {
      console.error(`agent guest idle for ${opts.idleExitMs}ms; exiting`);
      exit(0);
    }
  };
  const timer = setInterval(tick, opts.pollMs);
  timer.unref?.();

  return {
    isDraining: () => draining,
    startDrain: (deadlineMs?: number) => {
      draining = true;
      if (deadlineMs !== undefined) {
        drainDeadline = Math.min(drainDeadline, now() + deadlineMs);
      }
    },
    stop: () => clearInterval(timer),
  };
}
