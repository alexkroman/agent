// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox lifecycle, backed by remote Modal Sandboxes.
 *
 * The COMPLETE agent runs in the guest: the harness embeds the SDK runtime,
 * and clients connect DIRECTLY to the sandbox's public `/websocket` endpoint
 * (its Modal tunnel) — discovered via the platform's `GET /:slug/client-config`
 * broker. The host holds only the control channel (`sandbox-vm.ts`): bundle
 * loading, one-shot tool trials, the session-count probe idle eviction
 * consults, and the guest's ctx.db proxy.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { CloseableDb } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import { resolveHarnessPath } from "./constants.ts";
import { type IsolateConfig, StatusResponseSchema } from "./rpc-schemas.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { createSandboxVm } from "./sandbox-vm.ts";

// ── Types ───────────────────────────────────────────────────────────────

export type SandboxOptions = {
  workerCode: string;
  env: Record<string, string>;
  slug: string;
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfig;
  /**
   * App database handle when storage is enabled for this app (see
   * app-database.ts). The sandbox takes ownership and closes it on shutdown.
   */
  db?: CloseableDb;
  /** Optional pre-warmed harness pool for faster cold starts. */
  pool?: SandboxPool;
  /**
   * Called when the sandbox VM fails to start (rejected `vmReady`). The
   * sandbox object was already returned synchronously by then, so this is
   * the caller's hook to detach a now-permanently-broken sandbox from
   * wherever it was installed.
   */
  onVmFailed?: (err: unknown) => void;
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
  shutdown(): Promise<void>;
};

// ── Public API ──────────────────────────────────────────────────────────

export function createSandbox(opts: SandboxOptions): Sandbox {
  const { workerCode, env, slug, db } = opts;

  const config = opts.agentConfig;

  const vmReady = createSandboxVm(
    {
      slug,
      workerCode,
      env,
      // ctx.db for guest tool code and the in-guest runtime, proxied over
      // the db/query RPC. Absent (storage not enabled) the guest's ctx.db
      // getter throws guidance.
      ...(db && { db }),
      harnessPath: resolveHarnessPath(),
    },
    opts.pool,
  );

  vmReady
    .then(() => {
      debug("Sandbox ready", { slug, agent: config.name });
    })
    .catch((err: unknown) => {
      console.error("Sandbox VM failed to start", { slug, error: errorMessage(err) });
      opts.onVmFailed?.(err);
    });

  debug("Sandbox initializing", { slug, agent: config.name });

  return {
    sessionUrl: () => vmReady.then((handle) => handle.sessionUrl),

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
      // The sandbox owns the app db handle it was created with.
      await db?.close().catch(() => undefined);
    },
  };
}
