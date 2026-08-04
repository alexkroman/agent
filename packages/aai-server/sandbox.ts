// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox lifecycle, backed by remote Modal Sandboxes.
 *
 * The COMPLETE agent runs in the guest: the bundle ships the SDK runtime,
 * and clients connect DIRECTLY to the sandbox's public `/websocket` endpoint
 * (its Modal tunnel) — discovered via the platform's `GET /:slug/client-config`
 * broker. The host holds only the control channel (`sandbox-vm.ts`): bundle
 * loading, one-shot tool trials, and the session-count probe idle eviction
 * consults. (ctx.db is no longer host-proxied — the app's own DATABASE_URL
 * rides in the bundle/load env; see sandbox-resolve.ts.)
 */

import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import type { StoredAgentConfig } from "./agent-store.ts";
import { resolveHarnessPath } from "./constants.ts";
import { StatusResponseSchema } from "./rpc-schemas.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { createSandboxVm } from "./sandbox-vm.ts";

// ── Types ───────────────────────────────────────────────────────────────

export type SandboxOptions = {
  workerCode: string;
  env: Record<string, string>;
  slug: string;
  /**
   * The stored agent config — opaque to the host beyond `name` (used only
   * for logs here); the bundle interprets its own config in the guest.
   */
  agentConfig: StoredAgentConfig;
  /**
   * Harness image the agent was deployed against (per-deploy pinning —
   * see SandboxVmOptions.imageTag).
   */
  imageTag?: string | undefined;
  /** Optional pre-warmed harness pool for faster cold starts. */
  pool?: SandboxPool;
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
   * Modal tunnel). Resolves once the guest is configured; rejects when the
   * VM failed to start.
   */
  sessionUrl(): Promise<string>;
  /**
   * Live client sessions in the guest, for session-aware idle eviction
   * (sessions no longer pass through the host, so it must ask). A dead or
   * unreachable guest answers 0 — eviction should proceed.
   */
  activeSessions(): Promise<number>;
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
  shutdown(): Promise<void>;
};

// ── Public API ──────────────────────────────────────────────────────────

export function createSandbox(opts: SandboxOptions): Sandbox {
  const { workerCode, env, slug } = opts;

  const config = opts.agentConfig;

  const vmReady = createSandboxVm(
    {
      slug,
      workerCode,
      env,
      harnessPath: resolveHarnessPath(),
      imageTag: opts.imageTag,
    },
    opts.pool,
  );

  // "Unusable" is one state with two causes (never started / died later), so
  // it gets one flag and one notification. Without the exit half, a guest
  // killed mid-life stayed installed in its slot and the broker handed its
  // dead sessionUrl to every new client until idle eviction reclaimed it.
  //
  // Read the callback into a local rather than closing over `opts`: capturing
  // the options object would context-allocate it into the scope every returned
  // closure shares, so a resident sandbox would pin `opts.workerCode` — the
  // whole ~8 MB deploy bundle — in host heap for its entire life, long after
  // bundle/load shipped it to the guest.
  const onSandboxLost = opts.onSandboxLost;
  let lost = false;
  const markLost = (err?: unknown): void => {
    if (lost) return;
    lost = true;
    onSandboxLost?.(err);
  };

  vmReady
    .then((handle) => {
      debug("Sandbox ready", { slug, agent: config.name });
      handle.onExit(() => {
        console.warn("Sandbox guest exited", { slug });
        markLost();
      });
    })
    .catch((err: unknown) => {
      console.error("Sandbox VM failed to start", { slug, error: errorMessage(err) });
      markLost(err);
    });

  debug("Sandbox initializing", { slug, agent: config.name });

  return {
    sessionUrl: () => vmReady.then((handle) => handle.sessionUrl),

    alive: () => !lost,

    async activeSessions(): Promise<number> {
      try {
        const handle = await vmReady;
        const raw = await handle.conn.sendRequest("status");
        return StatusResponseSchema.parse(raw).activeSessions;
      } catch {
        // Unreachable/dead guest — report idle so eviction can reclaim it.
        return 0;
      }
    },

    async shutdown(): Promise<void> {
      try {
        const handle = await vmReady;
        await handle.shutdown();
      } catch {
        // VM failed to start or already shut down
      }
    },
  };
}
