// Copyright 2026 the AAI authors. MIT license.
/**
 * Subprocess-backed sandbox spawning — the NO-ISOLATION developer backend.
 *
 * The guest harness runs as a plain child process of the platform server,
 * listening on a loopback port. It is selected only in local dev, and only
 * when neither containerized backend is available (see `sandbox-backend.ts`);
 * production always resolves `modal`.
 *
 * ## What this is for
 *
 * Fidelity of *shape*, not of *isolation*. Everything between the host and the
 * guest is the real thing: a separate OS process with its own lifecycle, the
 * real `/ws` JSON-RPC control channel over a real WebSocket, the real
 * `bundle/load` → config-extraction path, real client sessions dialing
 * `/websocket` directly, the real dial-retry and orphan-timeout behavior. A
 * bug in any of those surfaces here exactly as it would in production.
 *
 * ## What it does NOT give you
 *
 * The container boundary, which is the entire security model. Tenant code runs
 * with the server process's uid, filesystem, and network. Two consequences:
 *
 * - **Never enable this outside a single-user dev machine.** There is no
 *   auto-selection path that can reach it in production, and no fallback
 *   *into* it from a failed containerized spawn — a failed spawn stays failed.
 * - Resource caps are approximated, not enforced. `SANDBOX_MEMORY_LIMIT_MB`
 *   becomes V8's `--max-old-space-size`, which bounds the JS heap only (not
 *   buffers, native memory, or child processes) and `SANDBOX_CPU_LIMIT` has no
 *   analog at all. So the "memory/CPU limits" row of the dev/prod divergence
 *   table in CLAUDE.md narrows here but does not close.
 *
 * ## Deliberate parity choices
 *
 * The guest gets a **minimal env**, not `process.env`. In production the guest
 * receives no host environment at all — its bearer token rides the Modal exec
 * env and the agent's own env arrives as `bundle/load` params. Inheriting the
 * server's env here would hand tenant code the platform's credentials
 * (`SUPABASE_DB_URL`, Modal tokens, the studio's `ASSEMBLYAI_API_KEY`) and,
 * worse for a dev backend, would make agent code that wrongly reads
 * `process.env` *work locally and fail in production* — precisely the class of
 * bug this backend exists to catch.
 *
 * The harness binds **loopback** via `AAI_GUEST_HOST`. `/websocket` is
 * auth-free by design (parity with the platform's public agent endpoint); in a
 * container that reaches no further than the container, but a bare subprocess
 * shares the dev machine's interfaces.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { parseSandboxLimitsFromEnv } from "./modal-sandbox-env.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import {
  type DialGuest,
  dialGuest,
  type GuestProcLike,
  getFreePort,
  warmFromGuest,
} from "./warm-harness.ts";

// ── Structural process types ─────────────────────────────────────────────────
// Injectable for tests, exactly like ModalSpawnContext:
// unit tests never start a real harness.

export type HarnessProcLike = GuestProcLike & {
  /** Terminate the child (SIGTERM, then SIGKILL if it lingers). */
  kill(): void;
};

export type HarnessSpawnParams = {
  /** Absolute path to the built `harness.mjs`. */
  harnessPath: string;
  /** Loopback port the harness binds directly (no port mapping here). */
  port: number;
  /** Per-sandbox bearer token for the `/ws` control channel. */
  token: string;
  memoryLimitMiB?: number | undefined;
};

export type SubprocessSpawnContext = {
  runGuestProcess(params: HarnessSpawnParams): HarnessProcLike;
};

/** The `node` invocation for a guest harness — pure so tests can assert it. */
export function buildHarnessSpawn(params: HarnessSpawnParams): {
  execArgv: string[];
  env: Record<string, string>;
  cwd: string;
} {
  return {
    // Bounds the JS heap only — see the module doc's caveat on resource caps.
    execArgv:
      params.memoryLimitMiB === undefined ? [] : [`--max-old-space-size=${params.memoryLimitMiB}`],
    env: {
      AAI_GUEST_TOKEN: params.token,
      AAI_GUEST_PORT: String(params.port),
      // Auth-free session endpoint: keep it off the dev machine's network.
      AAI_GUEST_HOST: "127.0.0.1",
      // The only inherited variable. A container image ships a PATH and tool
      // code may shell out; everything else is withheld (see module doc).
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    },
    // Not the server's cwd: a neutral directory mirrors the container's, and
    // keeps repo-relative paths from resolving inside the checkout.
    cwd: tmpdir(),
  };
}

// ── Default context (a real child process) ───────────────────────────────────

/** Grace between SIGTERM and SIGKILL when terminating a guest. */
const KILL_GRACE_MS = 250;

/**
 * `execPath` is injectable so tests can point at a binary that resolves
 * nowhere, exercising the error paths without starting a real harness.
 * Defaults to the Node binary running the server, so the guest is guaranteed
 * the same Node major as the host and does not depend on PATH resolution.
 */
function realContext(execPath = process.execPath): SubprocessSpawnContext {
  return {
    runGuestProcess(params) {
      const { execArgv, env, cwd } = buildHarnessSpawn(params);
      const child = spawn(execPath, [...execArgv, params.harnessPath], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const wait = new Promise<number>((resolve) => {
        // `error` (ENOENT etc.) and `close` both mean the guest is gone;
        // warm-harness only cares that wait() settles.
        child.once("error", () => resolve(-1));
        child.once("close", (code) => resolve(code ?? -1));
      });
      return {
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => wait,
        kill: () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          // The harness installs no SIGTERM handler, so this is normally
          // immediate; the timer is the backstop for a wedged event loop.
          const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          t.unref?.();
          void wait.then(() => clearTimeout(t));
        },
      };
    },
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness as a local child process and dial its WebSocket.
 * Mirrors `spawnModalWarm`: the returned
 * WarmHarness has a running harness process and a connected RPC channel, but
 * no listeners attached and no bundle loaded.
 */
export async function spawnSubprocessWarm(
  opts: { harnessPath: string; slug?: string },
  ctx: SubprocessSpawnContext = realContext(),
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const slug = opts.slug ?? "pool";
  const t0 = performance.now();
  try {
    // Checked up front so a missing build fails with the path that is missing,
    // rather than as a 30-second dial timeout against a process that exited
    // instantly. The containerized backends get this free from their copy step.
    await access(opts.harnessPath);
    const port = await getFreePort();
    const limits = parseSandboxLimitsFromEnv(process.env);
    const token = randomBytes(32).toString("hex");

    const proc = ctx.runGuestProcess({
      harnessPath: opts.harnessPath,
      port,
      token,
      memoryLimitMiB: limits.memoryLimitMiB,
    });

    // Best-effort and non-blocking, like the sibling backends' terminate: the
    // escalation to SIGKILL lives inside kill(), and `cleanup()` is memoized
    // and awaited by the pool and slot-eviction layers, so awaiting the
    // child's exit here would wedge every caller on a process that refuses
    // to die. `warmFromGuest` marks the harness dead on its own.
    const terminate = async (): Promise<void> => {
      proc.kill();
    };

    try {
      const ws = await dial(`ws://127.0.0.1:${port}/ws`, token);
      debug("Subprocess sandbox spawned", {
        slug,
        port,
        ms: Math.round(performance.now() - t0),
      });
      return warmFromGuest({
        label: `subprocess:${port}`,
        proc,
        terminate,
        ws,
        // The PUBLIC client-session endpoint — handed to browsers by the
        // client-config broker, loopback-only here.
        sessionUrl: `ws://127.0.0.1:${port}/websocket`,
      });
    } catch (err) {
      // Never leak a harness whose control channel failed to come up.
      await terminate().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    throw new Error(`Subprocess sandbox spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}

// ── Test-only internals ──────────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = { realContext };
