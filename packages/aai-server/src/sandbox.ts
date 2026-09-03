// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox lifecycle, backed by remote Modal Sandboxes.
 *
 * The guest IS a server: the COMPLETE agent runs in it (the bundle ships the
 * SDK runtime), clients connect DIRECTLY to its public `/websocket` endpoint
 * (discovered via the `GET /:slug/client-config` broker), and the host holds
 * NO channel to it — boot artifacts (bundle, hash, env) are delivered at
 * exec time, and the platform's only ongoing surface is the token-gated
 * `/manage/*` pair (a status probe for operators, and the drain request
 * retirement sends). See `spawnAgentServer` in sandbox-vm.ts.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { LogPage } from "@alexkroman1/aai-runtime";
import pTimeout from "p-timeout";
import { emptyLogPage, LOGS_READY_TIMEOUT_MS } from "./agent-logs.ts";
import { resolveHarnessPath, SANDBOX_TEARDOWN_READY_MS } from "./constants.ts";
import { createLogger } from "./logger.ts";
import { spawnAgentServer, type WorkerSource } from "./sandbox-vm.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

const log = createLogger("sandbox");

// ── Types ───────────────────────────────────────────────────────────────

export type SandboxOptions = {
  /** The bundle bytes, or a signed URL the guest pulls them from. */
  worker: WorkerSource;
  env: Record<string, string>;
  slug: string;
  /**
   * The deploy version this sandbox runs. Half the fleet-wide sandbox NAME
   * (see sandbox-directory.ts): Modal refuses a duplicate, so one deploy gets
   * one sandbox platform-wide with no lease table — and including the version
   * is what lets a blue-green handover boot the replacement while the old one
   * still drains.
   */
  version: number;
  /**
   * Harness image the agent was deployed against (per-deploy pinning —
   * see AgentSpawnOptions.imageTag).
   */
  imageTag?: string | undefined;
  /**
   * Called when the sandbox becomes permanently unusable — either the VM
   * failed to start (rejected `vmReady`) or the guest process exited after a
   * successful start. Both mean the same thing to a caller holding this
   * sandbox: its `sessionUrl` points at nothing. The sandbox object was
   * already returned synchronously by then, so this is the caller's hook to
   * detach it from wherever it was installed.
   *
   * Fires at most once.
   */
  onSandboxLost?: (err?: unknown) => void;
};

export type Sandbox = {
  /**
   * The sandbox's public client-session endpoint (`wss://…/websocket` on its
   * Modal tunnel). Resolves once the guest answers /health; rejects when the
   * VM failed to start.
   */
  sessionUrl(): Promise<string>;
  /**
   * The guest's origin (`wss://host:port`) — every guest HTTP surface
   * derives from it via GUEST_ROUTES (the client-config proxy), rather than
   * reverse-engineering URLs out of `sessionUrl`. Same readiness promise.
   */
  guestOrigin(): Promise<string>;
  /**
   * Hand the guest its drain budget (`POST /manage/drain?deadlineMs=`):
   * refuse new sessions and self-exit when empty or at the deadline — the
   * GUEST enforces the deadline; the host holds no drain state. REJECTS on
   * an unreachable guest so retirement can terminate instead (see
   * sandbox-retire.ts).
   */
  drain(deadlineMs?: number): Promise<void>;
  /**
   * This guest's buffered stdout/stderr (`GET /manage/logs`), for the studio's
   * Logs pane and `aai logs`.
   *
   * NEVER rejects, and a sandbox that is still BOOTING resolves an empty page
   * rather than waiting out its readiness: a log pane polls, and a poll that
   * blocks for the boot budget is a pane that hangs for two minutes on the one
   * agent whose output the user most wants to see.
   */
  logs(opts?: { after?: number; limit?: number }): Promise<LogPage>;
  /**
   * False once this sandbox is unusable — the VM failed to start, or the
   * guest process exited. A sandbox still booting reports true: pending is
   * not dead, and tearing one down mid-boot would just cost a respawn.
   *
   * Callers holding a sandbox across time (the slot cache) must consult this
   * before handing out `sessionUrl()`; the detach driven by `onSandboxLost`
   * is asynchronous, so there is a window where a dead sandbox is still
   * installed.
   */
  alive(): boolean;
  /**
   * End this sandbox. Asks the guest to shut itself down when it is (or
   * becomes) ready inside `SANDBOX_TEARDOWN_READY_MS`, and TERMINATES the
   * sandbox outright when it does not — a teardown may not depend on the boot
   * it is tearing down. Never rejects: every caller is already tearing down.
   */
  shutdown(): Promise<void>;
};

// ── Public API ──────────────────────────────────────────────────────────

export function createSandbox(opts: SandboxOptions): Sandbox {
  const { worker, env, slug } = opts;

  /**
   * Kill the guest without waiting for it to become ready — published by the
   * backend as soon as the sandbox exists (see `BackendAgentSpawn.onSpawned`),
   * which is what makes `shutdown()` below able to end a boot it is not
   * willing to wait out.
   */
  let terminateUnready: (() => Promise<void>) | undefined;

  const vmReady = spawnAgentServer({
    slug,
    onSpawned: (terminate) => {
      terminateUnready = terminate;
    },
    version: opts.version,
    worker,
    env,
    harnessPath: resolveHarnessPath(),
    imageTag: opts.imageTag,
  });

  // "Unusable" is one state with two causes (never started / died later), so
  // it gets one flag and one notification. Without the exit half, a guest
  // killed mid-life stayed installed in its slot and the broker handed its
  // dead sessionUrl to every new client until idle eviction reclaimed it.
  //
  // Read the callback into a local rather than closing over `opts`: capturing
  // the options object would context-allocate it into the scope every returned
  // closure shares, so a resident sandbox would pin an INLINE `opts.worker` —
  // the whole ~8 MB deploy bundle — in host heap for its entire life, long
  // after boot delivery shipped it to the guest. (A `url` source is a few
  // hundred bytes, but the trap is the same shape and the fix costs nothing.)
  const onSandboxLost = opts.onSandboxLost;
  let lost = false;
  const markLost = (err?: unknown): void => {
    if (lost) return;
    lost = true;
    onSandboxLost?.(err);
  };

  vmReady
    .then((handle) => {
      log.debug("Sandbox ready", { slug });
      handle.onExit(() => {
        log.warn("guest exited", { slug });
        markLost();
      });
    })
    .catch((err: unknown) => {
      log.error("VM failed to start", { slug, error: errorMessage(err) });
      markLost(err);
    });

  log.debug("Sandbox initializing", { slug });

  // The readiness wait the TEARDOWN paths take, bounded and memoized.
  //
  // Bounded because `vmReady` carries the BOOT budget (120s), which is the
  // right wait for a broker and the wrong one for a process that is exiting —
  // see SANDBOX_TEARDOWN_READY_MS. Lapsing is not walking away any more:
  // `shutdown` kills the sandbox when this wait runs out, and `drain` reports
  // the lapse so retirement terminates. `sessionUrl`/`guestOrigin`
  // deliberately keep the unbounded promise:
  // the broker caps its own wait (BROKER_READY_TIMEOUT_MS) and the boot must
  // continue behind it.
  //
  // Memoized so the budget is spent ONCE per sandbox, not once per caller.
  // `retireSandbox` calls `drain()` and then `shutdown()` on its failure path,
  // so a fresh timer each time would let one still-booting sandbox burn two
  // full budgets on its way out.
  // Clamped to >=1ms rather than honouring 0 the way SANDBOX_RETIRE_DRAIN_MS
  // and SHUTDOWN_GRACE_MS do: there, 0 selects a different BEHAVIOUR
  // (terminate immediately / skip the wait), while here it would only mean a
  // shorter wait — and p-timeout rejects a non-positive `milliseconds` with a
  // TypeError, which would turn every teardown into a thrown spawn error.
  const readyWaitMs = Math.max(1, SANDBOX_TEARDOWN_READY_MS);
  let teardownReady: Promise<AgentServerHandle> | null = null;
  const readyForTeardown = (): Promise<AgentServerHandle> => {
    teardownReady ??= pTimeout(vmReady, {
      milliseconds: readyWaitMs,
      message: `sandbox for ${slug} still booting after ${readyWaitMs}ms; abandoning teardown wait`,
    });
    return teardownReady;
  };

  return {
    sessionUrl: () => vmReady.then((handle) => handle.sessionUrl),
    // Bounded rather than awaited: see the doc on `logs` above. `pTimeout`
    // rather than a race against a timer — `guard-invariants` rule 3.
    logs: (logOpts) =>
      pTimeout(
        vmReady.then((handle) => handle.logs(logOpts)),
        { milliseconds: LOGS_READY_TIMEOUT_MS, fallback: () => emptyLogPage(logOpts?.after) },
      ).catch(() => emptyLogPage(logOpts?.after)),

    guestOrigin: () => vmReady.then((handle) => handle.guestOrigin),

    alive: () => !lost,

    async drain(deadlineMs?: number): Promise<void> {
      // Deliberately NOT swallowed: a rejected drain (VM never started,
      // guest gone, or — now — still booting past the teardown budget) is
      // retirement's signal to terminate rather than trust the guest to exit
      // itself.
      const handle = await readyForTeardown();
      await handle.drain(deadlineMs);
    },

    async shutdown(): Promise<void> {
      try {
        const handle = await readyForTeardown();
        await handle.shutdown();
        return;
      } catch {
        // VM failed to start, still booting past the budget, or already shut
        // down. No graceful path remains in any of the three, so fall through
        // to the kill.
      }
      // **A teardown may not depend on the boot it is tearing down.** This
      // used to be where shutdown GAVE UP: the `catch` was empty, and a guest
      // still booting past `SANDBOX_TEARDOWN_READY_MS` was "left to the
      // guest's own idle self-exit and Modal's sandbox timeout". A ~17s Modal
      // boot racing a project DELETE is what that costs — the delete drops the
      // app's Postgres role and database, the abandoned guest boots anyway,
      // and its workflow-world migration fails `28P01 password authentication
      // failed for user "app_<hex>"` on credentials that were valid when its
      // env was composed. Observed in production; the log reads like a storage
      // bug and is this. (Modal's own idle reclaim is the fallback under the
      // fallback, and it bills until it fires.)
      //
      // Swallowed rather than thrown, because every caller of `shutdown` is
      // already tearing down: `terminateSlot` logs and moves on, and a kill
      // that cannot be delivered leaves nothing this process can still do.
      try {
        await terminateUnready?.();
      } catch (err: unknown) {
        log.debug("Failed to terminate a still-booting sandbox", {
          slug,
          error: errorMessage(err),
        });
      }
    },
  };
}
