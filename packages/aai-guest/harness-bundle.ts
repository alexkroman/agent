// Copyright 2026 the AAI authors. MIT license.
/**
 * The bundle → runtime lifecycle: the harness's mutable state, `bundle/load`,
 * and the lazily-built runtime.
 *
 * Split out of harness.ts, which owns the servers and the control-channel
 * dispatch. The invariant that ties this module together is that the runtime
 * comes from the BUNDLE, never from the harness — see `HarnessState`.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AgentDef, CreateGuestRuntime, GuestRuntime } from "./harness-types.ts";
import type { StudioSession } from "./studio-chat.ts";
import { runCode } from "./trial.ts";

// ---- bundle/load ------------------------------------------------------------

let bundleSeq = 0;

/**
 * Import raw JS source as an ES module (no Function() evaluation, top-level
 * await supported). The code lands in a uniquely named temp file and is
 * imported by file URL — the unique name matters because Node's module
 * registry caches by URL, and a repeat bundle/load (the studio's build →
 * load → try loop) must load the NEW code.
 */
async function importBundleModule(code: string): Promise<Record<string, unknown>> {
  const path = `/tmp/aai-bundle-${process.pid}-${++bundleSeq}.mjs`;
  await writeFile(path, code, "utf-8");
  return await import(pathToFileURL(path).href);
}

// ---- Harness state ----------------------------------------------------------

/** Mutable state shared across requests within a single harness instance. */
export type HarnessState = {
  agent: AgentDef | null;
  /**
   * The bundle's own runtime factory (`__aaiCreateRuntime`) — the SDK
   * runtime SHIPS IN THE BUNDLE, pinned by the user's lockfile; the harness
   * embeds none. Required at bundle/load: every deployable bundle is built
   * by the CLI's wrapper, which always exports it.
   */
  createRuntime: CreateGuestRuntime | null;
  env: Readonly<Record<string, string>>;
  /**
   * The live runtime, created lazily on the first `/websocket` session upgrade —
   * NEVER at bundle/load: runtime construction resolves provider
   * credentials, and inspection loads (describeBundle, the studio) carry an
   * empty env that must not fail the load.
   */
  runtime: GuestRuntime | null;
  /** Live client-session connections (host idle eviction asks). */
  activeSessions: number;
  /**
   * The studio coding-agent session, installed by `studio/session-init` —
   * workspace dir, the caller's key (chat bearer + LLM credential), and
   * turn config. Null on non-studio sandboxes; `/studio/chat` answers 409.
   */
  studio: StudioSession | null;
};

/**
 * Load an agent ESM bundle delivered as raw JS source code.
 *
 * Bundles export `__aaiConfig` — the agent config extracted *inside* the
 * bundle (by `@alexkroman1/aai/manifest` helpers bundled in). Returning it
 * lets the host obtain the config without ever evaluating user code outside
 * the sandbox.
 *
 * Bundles also export `__aaiCreateRuntime` — the factory over THEIR OWN
 * bundled SDK's `createRuntime` (see the CLI's worker wrapper). The harness
 * ships no runtime of its own, so a bundle without the factory is not
 * loadable: fail here, at load, rather than as a dangling first session.
 */
export async function loadBundle(
  state: HarnessState,
  params: { code: string; env: Record<string, string> },
): Promise<{ config?: unknown }> {
  // A repeat load replaces the loaded agent; any live runtime ran the OLD
  // code — tear it down so the next session runs the new bundle.
  const oldRuntime = state.runtime;
  state.runtime = null;
  if (oldRuntime) void oldRuntime.shutdown().catch(() => undefined);

  const mod = await importBundleModule(params.code);
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object") {
    throw new Error("Agent bundle must export an object");
  }
  const createRuntime = (mod as { __aaiCreateRuntime?: unknown }).__aaiCreateRuntime;
  if (typeof createRuntime !== "function") {
    throw new Error(
      "Agent bundle does not export __aaiCreateRuntime (the bundle-shipped SDK runtime) — " +
        "rebuild it with a current @alexkroman1/aai-cli",
    );
  }

  state.agent = agent;
  state.createRuntime = createRuntime as CreateGuestRuntime;
  state.env = Object.freeze({ ...params.env });

  const config = (mod as { __aaiConfig?: unknown }).__aaiConfig;
  return config === undefined ? {} : { config };
}

/**
 * The runtime for the loaded bundle, created on first use — by the BUNDLE'S
 * OWN `createRuntime` (its `__aaiCreateRuntime` export), so a deployed agent
 * runs exactly the SDK version it was built and tested against; the harness
 * embeds no runtime. This is the SDK's self-hosted path running INSIDE the
 * sandbox: tools execute in-process, providers and tool-code fetch dial out
 * directly (open egress — the container is the boundary), exactly as
 * `aai dev` does. ctx.db is the runtime's own connection to the env's
 * DATABASE_URL (the app's scoped credentials, injected by the host at
 * bundle/load); run_code gets this guest's real executor.
 */
export function ensureRuntime(state: HarnessState): GuestRuntime {
  if (!(state.agent && state.createRuntime)) throw new Error("Agent not loaded");
  state.runtime ??= state.createRuntime({
    env: { ...state.env },
    runCode,
  });
  return state.runtime;
}
