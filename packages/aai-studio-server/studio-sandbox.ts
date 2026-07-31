// Copyright 2025 the AAI authors. MIT license.
/**
 * Per-chat-session sandbox for the studio's coding agent.
 *
 * The coding agent's code-executing work — loading the user's bundle,
 * extracting its config, and trial-running its tools — happens inside a
 * sandbox provisioned through the exact same machinery as deployed agents:
 * the orchestrator's warm pool when available, otherwise
 * `spawnWarmHarness` (a remote Modal Sandbox). The
 * host never evaluates workspace code.
 *
 * Unlike a deployed agent's sandbox, a studio session sandbox:
 * - starts with no bundle and can re-`loadBundle` repeatedly (the harness
 *   replaces the loaded agent), giving the coding agent a build → load →
 *   try loop against the production runtime;
 * - is wired to a scratch in-memory Vector and NO app database — trial tool
 *   runs never touch platform data, and no tenant secrets enter the guest.
 *   A trial run that touches ctx.db gets the self-explanatory
 *   storage-not-enabled error.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createMemoryVector } from "@alexkroman1/aai/runtime";
import { resolveHarnessPath } from "aai-server/constants";
import type { BundleLoadResult } from "aai-server/rpc-schemas";
import { registerGuestRpcHandlers } from "aai-server/sandbox-guest-rpc";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { spawnWarmHarness, type WarmHarness } from "aai-server/sandbox-vm";

/** Session id used for trial tool executions inside the guest. */
const TRIAL_SESSION_ID = "studio-trial";

/**
 * Reported for calls that arrive after this turn's sandbox is gone. The
 * transport's own "Connection disposed" is a host internal, and these strings
 * are read by the coding agent — it needs a cause it can act on, not one that
 * reads like the user's bundle is broken.
 */
const DISPOSED_MESSAGE =
  "The sandbox for this turn was torn down because the chat turn ended. " +
  "Retry and it will run in a fresh sandbox.";

export type StudioSandbox = {
  /** Load (or replace) the worker bundle; returns its self-described config. */
  loadBundle(code: string): Promise<{ config?: unknown }>;
  /** Execute one of the loaded agent's tools; returns result or error text. */
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;
  dispose(): Promise<void>;
};

export type StudioSandboxOptions = {
  /** Pre-warmed harness pool shared with deployed-agent sandboxes. */
  pool?: SandboxPool | undefined;
  harnessPath?: string;
  /** Injectable for tests — defaults to the shared warm-harness spawner. */
  spawn?: typeof spawnWarmHarness;
};

export async function createStudioSandbox(opts: StudioSandboxOptions = {}): Promise<StudioSandbox> {
  const spawn = opts.spawn ?? spawnWarmHarness;
  const harnessPath = opts.harnessPath ?? resolveHarnessPath();

  // Scratch Vector so trial tool runs behave realistically (ctx.vector works)
  // without reaching any tenant data. No db (ctx.db throws the
  // storage-not-enabled error) and no allowedHosts — guest fetch is off.
  const wire = (warm: WarmHarness): WarmHarness => {
    registerGuestRpcHandlers(warm.conn, {
      vector: createMemoryVector({ namespace: TRIAL_SESSION_ID }),
    });
    warm.conn.listen();
    return warm;
  };

  const pooled: WarmHarness | null = (await opts.pool?.acquire()) ?? null;
  let live = wire(pooled ?? (await spawn({ harnessPath, slug: "studio-session" })));
  /** False only while `live` is still the pooled harness. */
  let freshlySpawned = pooled === null;

  let disposed = false;
  const inFlight = new Set<Promise<unknown>>();

  /**
   * A pooled harness can die between the pool's alive() check and its first
   * use here — the same race `createSandboxVm` falls back to a cold spawn
   * for. One-shot: dispose the dead pooled harness and retry `op` on a fresh
   * spawn, which either works or surfaces the real error.
   */
  async function withPooledRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (freshlySpawned || disposed) throw err;
      freshlySpawned = true;
      console.warn("Studio sandbox: pooled harness failed; retrying on a fresh spawn", {
        error: errorMessage(err),
      });
      await live[Symbol.asyncDispose]();
      live = wire(await spawn({ harnessPath, slug: "studio-session" }));
      return await op();
    }
  }

  /**
   * Runs one guest request, keeping `dispose()` from yanking the connection
   * out from under it.
   *
   * A turn settles — finish, model error, or client abort — while `test_agent`
   * is still mid-request, and the teardown is fire-and-forget
   * (`studio-agent.ts`). Disposing the transport there rejected the pending
   * request with "Connection disposed", which the tool then reported as
   * "Bundle failed to load in the sandbox", i.e. as the user's bundle being at
   * fault. The window is wide in production because the Vite worker build in
   * front of `loadBundle` takes seconds on a one-CPU host.
   */
  async function track<T>(op: () => Promise<T>): Promise<T> {
    if (disposed) throw new Error(DISPOSED_MESSAGE);
    const pending = op();
    inFlight.add(pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(pending);
    }
  }

  return {
    loadBundle(code: string) {
      return track(() =>
        withPooledRetry(async () => {
          // Guest-asserted wire data; the caller validates `config` with
          // IsolateConfigSchema (see BundleLoadResult in rpc-schemas.ts).
          const result = (await live.conn.sendRequest("bundle/load", {
            code,
            env: {},
          })) as BundleLoadResult | undefined;
          return { ...(result?.config !== undefined && { config: result.config }) };
        }),
      );
    },

    executeTool(name: string, args: Record<string, unknown>) {
      return track(() =>
        withPooledRetry(async () => {
          const response = (await live.conn.sendRequest("tool/execute", {
            name,
            args,
            sessionId: TRIAL_SESSION_ID,
            messages: [],
          })) as { result?: string; error?: string } | undefined;
          if (response?.error) return `Tool error: ${response.error}`;
          return response?.result ?? "(no result)";
        }),
      );
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Let in-flight requests settle before tearing the transport down.
      // Bounded, not open-ended: every request carries the transport's own
      // timeout, so a wedged guest delays teardown but cannot block it.
      if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      await live[Symbol.asyncDispose]();
    },
  };
}
