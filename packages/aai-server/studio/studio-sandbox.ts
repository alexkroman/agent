// Copyright 2025 the AAI authors. MIT license.
/**
 * Per-chat-session sandbox for the studio's coding agent.
 *
 * The coding agent's code-executing work — loading the user's bundle,
 * extracting its config, and trial-running its tools — happens inside a
 * sandbox provisioned through the exact same machinery as deployed agents:
 * the orchestrator's warm pool when available, otherwise
 * `spawnWarmHarness` (gVisor on Linux, dev child process elsewhere). The
 * host never evaluates workspace code.
 *
 * Unlike a deployed agent's sandbox, a studio session sandbox:
 * - starts with no bundle and can re-`loadBundle` repeatedly (the harness
 *   replaces the loaded agent), giving the coding agent a build → load →
 *   try loop against the production runtime;
 * - is wired to a scratch in-memory KV/Vector — trial tool runs never
 *   touch platform data, and no tenant secrets enter the guest.
 */

import type { Kv } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai";
import { createMemoryVector } from "@alexkroman1/aai/runtime";
import { resolveHarnessPath } from "../constants.ts";
import { registerGuestRpcHandlers } from "../sandbox-guest-rpc.ts";
import type { SandboxPool } from "../sandbox-pool.ts";
import { spawnWarmHarness, type WarmHarness } from "../sandbox-vm.ts";

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

function scratchKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve((map.get(key) as never) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
      return Promise.resolve();
    },
  };
}

export async function createStudioSandbox(opts: StudioSandboxOptions = {}): Promise<StudioSandbox> {
  const spawn = opts.spawn ?? spawnWarmHarness;
  const harnessPath = opts.harnessPath ?? resolveHarnessPath();

  let warm: WarmHarness | null = (await opts.pool?.acquire()) ?? null;
  if (!warm) {
    warm = await spawn({ harnessPath, slug: "studio-session" });
  }
  const live = warm;

  // Scratch KV/Vector so trial tool runs behave realistically (ctx.kv works)
  // without reaching any tenant data. No allowedHosts — guest fetch is off.
  registerGuestRpcHandlers(live.conn, {
    kv: scratchKv(),
    vector: createMemoryVector({ namespace: TRIAL_SESSION_ID }),
  });
  live.conn.listen();

  let disposed = false;
  const inFlight = new Set<Promise<unknown>>();

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
      return track(async () => {
        const result = await live.conn.sendRequest<{ ok: boolean; config?: unknown }>(
          "bundle/load",
          { code, env: {} },
        );
        return { ...(result?.config !== undefined && { config: result.config }) };
      });
    },

    executeTool(name: string, args: Record<string, unknown>) {
      return track(async () => {
        const response = await live.conn.sendRequest<{ result?: string; error?: string }>(
          "tool/execute",
          { name, args, sessionId: TRIAL_SESSION_ID, messages: [] },
        );
        if (response?.error) return `Tool error: ${response.error}`;
        return response?.result ?? "(no result)";
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Let in-flight requests settle before tearing the transport down.
      // Bounded, not open-ended: every request carries the transport's own
      // timeout, so a wedged guest delays teardown but cannot block it.
      if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      try {
        void live.conn.sendNotification("shutdown");
        live.conn.dispose();
        await live.cleanup();
      } catch (err) {
        console.warn("Studio sandbox teardown failed:", errorMessage(err));
      }
    },
  };
}
