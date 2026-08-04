// Copyright 2026 the AAI authors. MIT license.
/**
 * AGENT-MODE guest support: the "guest is a server" contract.
 *
 * In agent mode (`AAI_GUEST_MODE=agent`) the guest receives EVERYTHING at
 * exec time and holds no host connection at all:
 *
 * - the worker bundle and the agent env arrive as files written into the
 *   sandbox before exec (`AAI_BUNDLE_PATH` + `AAI_BUNDLE_SHA256`,
 *   `AAI_AGENT_ENV_PATH`) — {@link readAgentBoot} loads and hash-verifies
 *   them;
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

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type http from "node:http";
import { verifyBearer } from "./harness-auth.ts";
import { GUEST_CONTRACT_VERSION } from "./limits.ts";

// ---- Boot artifacts ----------------------------------------------------------

export type AgentBoot = {
  /** The worker bundle source (hash-verified). */
  code: string;
  /** The agent's env (`ctx.env` + provider credentials + DATABASE_URL). */
  env: Record<string, string>;
};

/**
 * Read the boot artifacts the spawner delivered into the sandbox. The bundle
 * hash is verified against `AAI_BUNDLE_SHA256` — the blob store is
 * content-addressed, so this extends "a wrong blob is structurally
 * impossible" through the delivery path; a mismatch is a hard boot failure
 * (exit, respawn), never a silently different agent. The env file is
 * best-effort deleted after reading so the secrets live in process memory
 * rather than on the sandbox disk.
 */
export async function readAgentBoot(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentBoot> {
  const bundlePath = env.AAI_BUNDLE_PATH;
  const expected = env.AAI_BUNDLE_SHA256;
  if (!(bundlePath && expected)) {
    throw new Error("agent mode requires AAI_BUNDLE_PATH and AAI_BUNDLE_SHA256");
  }
  const code = await readFile(bundlePath, "utf-8");
  const actual = createHash("sha256").update(code, "utf-8").digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `bundle hash mismatch: expected sha256 ${expected}, got ${actual} — refusing to load`,
    );
  }

  const agentEnv: Record<string, string> = {};
  const envPath = env.AAI_AGENT_ENV_PATH;
  if (envPath) {
    const raw = JSON.parse(await readFile(envPath, "utf-8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("agent env file must contain a JSON object");
    }
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string") {
        throw new Error(`agent env value for ${key} must be a string`);
      }
      agentEnv[key] = value;
    }
    await rm(envPath, { force: true }).catch(() => undefined);
  }
  return { code, env: agentEnv };
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
  /** Request a drain: refuse new sessions, exit when the last one ends. */
  startDrain: () => void;
};

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
      deps.startDrain();
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
  startDrain: () => void;
  /** Stop the poll timer (tests). */
  stop: () => void;
};

/**
 * Guest-owned lifecycle: exit 0 once idle past `idleExitMs` (0 disables), or
 * as soon as a requested drain sees zero sessions. This replaces the
 * control-channel orphan timeout — an agent-mode guest has no host socket,
 * so "nobody needs me" is measured by its own session count.
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
  let lastBusy = now();

  const tick = (): void => {
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
    startDrain: () => {
      draining = true;
    },
    stop: () => clearInterval(timer),
  };
}
