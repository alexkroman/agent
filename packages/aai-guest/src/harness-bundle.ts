// Copyright 2026 the AAI authors. MIT license.
/**
 * The bundle → runtime lifecycle: the harness's mutable state, `loadBundle`,
 * and the lazily-built runtime.
 *
 * Split out of harness.ts, which owns the servers and the control-channel
 * dispatch. The invariant that ties this module together is that the runtime
 * comes from the BUNDLE, never from the harness — see `HarnessState`.
 */

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { SessionRuntime } from "@alexkroman1/aai-runtime";
import { publishStepEnv, publishWorkflowWebhookUrl } from "@alexkroman1/aai-runtime/internal";
import type { AgentDef, CreateGuestRuntime, GuestRuntime } from "./harness-types.ts";
import type { StudioSession } from "./studio-session.ts";
import { runCode } from "./trial.ts";

// ---- Bundle loading ----------------------------------------------------------

let bundleSeq = 0;

/**
 * Where a bundle file is written — and it is a RESOLUTION ANCHOR, not scratch
 * space.
 *
 * It used to be `tmpdir()`, under a comment asserting that "the bundle is fully
 * inlined (`ssr.noExternal: true`), so the directory carries no resolution
 * meaning here". That was true of the bundler's own output and false of what the
 * bundle DOES at runtime: the Workflow DevKit selects its world adapter by
 * `require`ing a package NAME, which no bundler can inline, and the bundled SDK's
 * CJS interop anchors that require on `createRequire(import.meta.url)` — i.e. on
 * this file's directory. From `tmpdir()` there is no `node_modules` above it, so
 * a durable workflow agent died on `Cannot find module
 * '@workflow/world-postgres'` with a require stack naming a path in `/T/`.
 *
 * The harness's OWN directory is the anchor that works, in both deployments and
 * for the same reason each: `/opt/aai/harness.mjs` sits beside
 * `/opt/aai/node_modules` in the baked image, and `dist/harness.mjs` is one level
 * under `aai-guest/node_modules` in dev. That is the same walk-up the harness
 * itself relies on for every `neverBundle` package (see this package's guide).
 *
 * A directory that cannot be written falls back to `tmpdir()` and SAYS SO,
 * naming what will not work. Silence there would be the works-here/fails-there
 * asymmetry this package's own parity table exists to enumerate — and the
 * fallback is still strictly better than failing the load, because an agent with
 * no workflows never needs the anchor at all.
 *
 * So: this module's own directory, which after bundling is the one holding
 * `harness.mjs`. Exported so a spec can assert the anchor without recomputing
 * it — the failure this guards is a bundle landing somewhere with no
 * `node_modules` above it, and a test that derived the expected path the same
 * way the code does would agree with a wrong answer.
 */
export function harnessBundleDir(): string {
  return import.meta.dirname;
}

async function writeBundleFile(name: string, code: string): Promise<string> {
  const beside = join(harnessBundleDir(), name);
  try {
    await writeFile(beside, code, "utf-8");
    return beside;
  } catch (err) {
    // `tmpdir()`, never a literal `/tmp`: this runs on the DEVELOPER's machine
    // under `aai dev` too, where that literal is drive-relative on Windows.
    const fallback = join(tmpdir(), name);
    console.warn(
      `Bundle written to ${tmpdir()} rather than beside the harness ` +
        `(${errorMessage(err)}). A workflow world resolved by runtime require ` +
        "will not load from there.",
    );
    await writeFile(fallback, code, "utf-8");
    return fallback;
  }
}

/**
 * Import raw JS source as an ES module (no Function() evaluation, top-level
 * await supported). The code lands in a uniquely named temp file and is
 * imported by file URL — the unique name matters because Node's module
 * registry caches by URL, and a repeat load (the studio's build →
 * load → try loop) must load the NEW code.
 */
async function importBundleModule(code: string): Promise<Record<string, unknown>> {
  const name = `aai-bundle-${process.pid}-${++bundleSeq}.mjs`;
  const path = await writeBundleFile(name, code);
  try {
    return await import(pathToFileURL(path).href);
  } finally {
    // Unlinked as soon as the loader is done with it. The unique name exists so
    // a REPEAT load runs the new code (Node caches the registry by URL), so
    // nothing ever reads this path twice — and the studio's build → load → try
    // loop calls `test_agent` after every meaningful change, at ~8 MB a time,
    // into a sandbox that lives for hours. Nothing was deleting them.
    //
    // Safe after the import resolves: the module is compiled and instantiated,
    // and the bundle's own `createRequire(import.meta.url)` uses this path only
    // as a resolution ANCHOR, which needs no file. The one thing given up is
    // Node printing the source line under a stack frame from inside the bundle;
    // the frame, the file and the line still appear.
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * The deployment's public origin, out of the EXEC env — what a THIRD PARTY dials.
 *
 * One reader for two consumers ({@link loadBundle}'s webhook minter and
 * {@link ensureRuntime}'s `publicUrl`), because they must not be able to
 * disagree about what this sandbox's callback origin is. It is the SPAWNER's
 * parameter and not the agent's: `AAI_PUBLIC_BASE_URL` is set in the exec env
 * (`agentBootEnv` in aai-server/warm-harness.ts) and never appears in the agent
 * env file, so a tenant cannot set it and `requireStepEnv` cannot read it.
 *
 * Blank-trimmed to `undefined` rather than passed through: an exec env built
 * from a template can carry an empty string, and an empty base composes
 * `/.well-known/…` — a relative URL nothing can call back on — where
 * `undefined` makes both consumers say so by name.
 *
 * Not `AAI_PLATFORM_BASE_URL`, which is the other claim entirely: "the platform
 * is dialable here", from INSIDE the sandbox. See
 * `aai-runtime/CLAUDE.md`, "`AAI_PUBLIC_BASE_URL` is what a THIRD PARTY dials".
 */
function publicBaseUrl(): string | undefined {
  return process.env.AAI_PUBLIC_BASE_URL?.trim() || undefined;
}

// ---- Harness state ----------------------------------------------------------

/** Mutable state shared across requests within a single harness instance. */
export type HarnessState = {
  agent: AgentDef | null;
  /**
   * The bundle's own runtime factory (`__aaiCreateRuntime`) — the SDK
   * runtime SHIPS IN THE BUNDLE, pinned by the user's lockfile; the harness
   * embeds none. Required at load: every deployable bundle is built
   * by the CLI's wrapper, which always exports it.
   */
  createRuntime: CreateGuestRuntime | null;
  env: Readonly<Record<string, string>>;
  /**
   * The live runtime, created lazily on the first `/websocket` session upgrade —
   * NEVER at load: runtime construction resolves provider
   * credentials, and an inspection load (the studio's test_agent) carries an
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

/** A fresh, nothing-loaded harness state — the one shape, built once. */
export function emptyHarnessState(): HarnessState {
  return {
    agent: null,
    createRuntime: null,
    env: Object.freeze({}),
    runtime: null,
    activeSessions: 0,
    studio: null,
  };
}

/**
 * Load an agent ESM bundle delivered as raw JS source code.
 *
 * Bundles export `__aaiConfig` — the agent config extracted *inside* the
 * bundle (by `@alexkroman1/aai/manifest` helpers bundled in). The studio's
 * `test_agent` reports it back to the coding agent; the platform never asks
 * for it (see "The platform stores no agent config" in
 * packages/aai-server/CLAUDE.md).
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
  // `unknown`, not `as AgentDef`: this is a tenant's bundle exporting whatever
  // it likes, so the assertion has to come AFTER the check rather than instead
  // of it. Asserting first made the guard below provably dead to the checker
  // while it stayed load-bearing at runtime — the type stopped marking where
  // the trust boundary is, and deleting the guard would have raised no error.
  const exported: unknown = mod.default ?? mod;

  // `isRecord`, not a hand-written `typeof … !== "object" || … === null`: same
  // guard, one spelling, and the one `guard-invariants` rule 17 recognizes. It
  // also refuses an ARRAY, which the hand-written form let through — into a
  // cast to `AgentDef` — while the message beside it already said "an object".
  if (!isRecord(exported)) {
    throw new Error("Agent bundle must export an object");
  }
  const agent = exported as AgentDef;
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

  // The same env the runtime resolves credentials from, reachable from a
  // `"use step"` body — which is handed no tool context and, without this, has
  // no way to authenticate an outbound call at all. Published BEFORE the
  // surface is built so a step dispatched by the first replay cannot race it,
  // and here rather than in agent mode so the studio's `test_agent` load gets
  // the identical wiring.
  publishStepEnv(params.env);

  // How a step mints THIS run's public callback URL, which closes the other half
  // of the same gap: a workflow body and the steps it calls hold no
  // `ToolContext`, so `ctx.workflows.publicWebhookUrl` is out of reach — and a
  // `workflowApp()` with no tools at all had nothing that could mint one, so a
  // run had to poll a provider instead of being woken by it. The value is the
  // spawner's rather than the agent's (see {@link publicBaseUrl}), so it cannot
  // ride the env published above.
  //
  // Published HERE for the reason the env is: before the surface is built, so a
  // run the platform's queue delivers the moment this process boots cannot race
  // it — `ensureRuntime` is too late, being lazy and possibly never called for a
  // static app. Absent, it UNPUBLISHES, so a repeat load in a process that lost
  // the variable cannot leave a stale origin behind.
  publishWorkflowWebhookUrl(publicBaseUrl());

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
 * DATABASE_URL (the app's scoped credentials, delivered in the
 * agent's boot env); run_code gets this guest's real executor.
 *
 * `publicUrl` comes from `AAI_PUBLIC_BASE_URL` in the EXEC env, not from the
 * agent env file — it is a boot parameter the spawner knows and the agent does
 * not (see `agentBootEnv` in aai-server/warm-harness.ts). Reading it here is
 * what keeps the SDK free of the platform's vocabulary: the harness translates
 * one `AAI_*` key into the SDK's own `publicUrl` option, exactly as it
 * translates its sandbox executor into `runCode`. Absent under `aai dev`'s
 * subprocess backend and in tests, where the SDK's own throw names the option.
 */
export function ensureRuntime(state: HarnessState): GuestRuntime {
  if (!(state.agent && state.createRuntime)) throw new Error("Agent not loaded");
  // Through {@link publicBaseUrl}, which is also what the step slot's minter is
  // built from — one reader, so a tool's callback URL and a step's cannot name
  // different origins.
  const publicUrl = publicBaseUrl();
  state.runtime ??= state.createRuntime({
    env: { ...state.env },
    runCode,
    ...omitUndefined({ publicUrl }),
  });
  return state.runtime;
}

/**
 * The session-facing runtime handed to `createRuntimeServer` — a lazy facade over
 * `ensureRuntime` so the real runtime is built on the FIRST session (with
 * the loaded bundle's env), plus the live-session count the host's idle
 * eviction asks for over `status`.
 */
export function lazyRuntime(
  state: HarnessState,
  hooks: {
    /**
     * Pre-session refusal, checked before anything starts: return a close
     * code + reason to turn the session away (agent mode's drain refusal —
     * 1013 "try again" makes the client re-broker onto the replacement).
     * The one refusal path, shared with the runtime-build failure below.
     */
    refuse?: () => { code: number; reason: string } | null;
  } = {},
): SessionRuntime {
  return {
    startSession(ws, opts) {
      const refusal = hooks.refuse?.();
      if (refusal) {
        ws.close?.(refusal.code, refusal.reason);
        return;
      }
      state.activeSessions++;
      ws.addEventListener("close", () => {
        state.activeSessions = Math.max(0, state.activeSessions - 1);
      });
      let runtime: GuestRuntime;
      try {
        runtime = ensureRuntime(state);
      } catch (err) {
        // No bundle yet, or the runtime can't be built (missing provider
        // credential, invalid config) — answer with a close frame naming
        // the cause instead of a dangling socket.
        console.error(`session refused: ${errorMessage(err)}`);
        ws.close?.(1011, errorMessage(err).slice(0, 100));
        return;
      }
      runtime.startSession(ws, opts);
    },
    /**
     * `ctx.workflows`, for the workflow API `createRuntimeServer` mounts.
     *
     * A GETTER, and that is the whole point of it being here rather than a
     * captured value. The runtime is built on first use, and for a
     * `page: "static"` app the first use is a REQUEST TO THIS API rather than a
     * session — there may never be one. Reading the property is therefore what
     * builds the runtime, and a value captured when the facade was constructed
     * would be `undefined` for the life of the server.
     *
     * It may THROW (no bundle yet, a missing provider credential), which the API
     * reports as a 500 naming the cause. That is the intended answer: swallowing
     * it would make a misconfigured agent claim it declares no workflows.
     */
    get workflows() {
      return ensureRuntime(state).workflows as SessionRuntime["workflows"];
    },
    /**
     * The delivery hook, a GETTER for the same lazy-runtime reason as `workflows`.
     *
     * A bundle predating the replay engine has none, and `undefined` is the
     * honest answer there rather than a throwing stub: that bundle's runs belong
     * to the DevKit's own world, which holds their schedule itself.
     */
    get deliverWorkflow() {
      return ensureRuntime(state).deliverWorkflow as SessionRuntime["deliverWorkflow"];
    },
    shutdown: async () => {
      await state.runtime?.shutdown();
    },
  };
}
