// Copyright 2025 the AAI authors. MIT license.
/**
 * Dev server for directory-based agents.
 *
 * Imports agent.ts directly for the full agent definition,
 * builds a runtime, and starts an HTTP+WebSocket server. Watches for
 * file changes and restarts automatically. Optionally runs Vite for
 * client SPA HMR.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import {
  type AgentServer,
  requiredProviderEnvVars,
  withHostCredentialFallback,
} from "@alexkroman1/aai/runtime";
import { type FSWatcher, watch } from "chokidar";
import getPort, { portNumbers } from "get-port";
import pDebounce from "p-debounce";
import type { ViteDevServer } from "vite";
import { createWorkerEvaluator } from "./_bundler.ts";
import { ensureApiKey } from "./_config.ts";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { createDevWorkerBuilder, isEsbuildBuildFailure } from "./_dev-bundler.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";
import { errorCode, errorMessage } from "./_utils.ts";
import { buildWorker } from "./worker-bundler.ts";

// ─── Env loading ────────────────────────────────────────────────────────────

async function resolveAgentEnv(root: string, agentDef: AgentDef): Promise<Record<string, string>> {
  const env = await resolveServerEnv(root);
  // Derived from the provider registries rather than matched against hardcoded
  // kinds, so a new provider needs no change here and nothing is missed. (The
  // previous check looked only at `stt`/`llm` and only for AssemblyAI.)
  const required = requiredProviderEnvVars(agentDef);

  // Only AssemblyAI's key has an interactive setup flow (it doubles as the
  // platform credential), so that one is prompted for.
  if (required.includes("ASSEMBLYAI_API_KEY") && !env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = await ensureApiKey();
  }

  // The rest would otherwise surface as an auth failure on the first session.
  const missing = required.filter((name) => !(env[name] || process.env[name]));
  if (missing.length > 0) {
    log.warn(
      `Missing provider credential${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Set ${missing.length > 1 ? "them" : "it"} in .env or the environment.`,
    );
  }
  return env;
}

/**
 * The env handed to `createServer` for host-mode connections: provider
 * credentials plus the `AAI_ALLOW_HOST` gate read straight from the shell
 * (it is a control variable, not something an agent declares in `.env`).
 */
function hostModeEnv(providerEnv: Record<string, string>): Record<string, string> {
  const gate = process.env.AAI_ALLOW_HOST;
  return gate === undefined ? providerEnv : { ...providerEnv, AAI_ALLOW_HOST: gate };
}

/**
 * Explicit bind host for the dev server, or `undefined` to take the
 * loopback default. An empty `AAI_DEV_HOST` means "unset", not "every
 * interface" — Node treats `listen(port, "")` as 0.0.0.0, which would quietly
 * undo the loopback default this exists to guard.
 */
function devBindHost(): string | undefined {
  const host = process.env.AAI_DEV_HOST?.trim();
  return host ? host : undefined;
}

// ─── Agent loading ──────────────────────────────────────────────────────────

/**
 * Load the agent definition by bundling agent.ts (and all its local imports)
 * into a single ESM file, then importing that. A raw `import(agent.ts?t=...)`
 * only cache-busts agent.ts itself — transitive imports (./tools.ts, etc.)
 * stay in Node's ESM registry, so edits to them are ignored on reload.
 * Bundling picks them up.
 *
 * The bundle comes from the incremental esbuild builder (`_dev-bundler.ts`)
 * rather than the deploy path's cold Vite build — a save rebuilds in tens of
 * ms instead of 1–3 s. Compile errors in the agent's code propagate (the
 * restart loop reports them and keeps the old server); any other builder
 * failure falls back to the cold Vite build so an esbuild-specific gap can't
 * take the dev loop down. Evaluation goes through the memoizing evaluator so
 * a no-op save doesn't leak another module into the ESM registry.
 */
export async function loadAgentDefWith(
  cwd: string,
  builder: Pick<ReturnType<typeof createDevWorkerBuilder>, "build">,
  evaluate: (code: string) => Promise<AgentDef>,
): Promise<AgentDef> {
  let code: string;
  try {
    code = await builder.build();
  } catch (err) {
    if (isEsbuildBuildFailure(err)) throw err;
    code = await buildWorker(cwd);
  }
  return evaluate(code);
}

// ─── File watching ──────────────────────────────────────────────────────────

/**
 * True for paths that should never trigger a restart: anything inside
 * `node_modules/` and any dot-entry (`.git/`, `.aai/`, `.DS_Store`, …).
 * `.git/` especially matters — commits and status checks churn the index
 * and would otherwise cause spurious full backend restarts.
 *
 * Exception: `.env` / `.env.*` files stay watched — env edits should
 * restart the server with the new values.
 */
export function isIgnoredPath(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  if (!rel || rel.startsWith("..")) return false;
  return rel.split(path.sep).some((segment) => {
    if (segment === "node_modules") return true;
    if (segment === ".env" || segment.startsWith(".env.")) return false;
    return segment.startsWith(".");
  });
}

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts. Uses chokidar for reliable recursive
 * watching across platforms (raw `fs.watch` misses events on Linux).
 */
export function watchDirectory(dir: string, onChange: () => void): FSWatcher {
  const DEBOUNCE_MS = 300;

  const debouncedChange = pDebounce(() => {
    log.info("File change detected, restarting...");
    onChange();
  }, DEBOUNCE_MS);

  const watcher = watch(dir, {
    ignored: (filePath: string) => isIgnoredPath(dir, filePath),
    ignoreInitial: true,
    persistent: false,
  });
  // Without an 'error' listener an ENOSPC/EMFILE from the OS watcher would
  // either crash the process (unhandled 'error') or kill watching silently.
  watcher.on("error", (err: unknown) => {
    const hint =
      errorCode(err) === "ENOSPC"
        ? " The inotify watch limit was reached — raise the fs.inotify max_user_watches sysctl."
        : "";
    log.error(
      `File watcher error: ${errorMessage(err)}.${hint} ` +
        "Auto-restart on file changes may have stopped; restart `aai dev` after fixing.",
    );
  });
  watcher.on("all", () => {
    // debouncedChange resolves after onChange runs — a throw there must not
    // become an unhandled rejection that kills the dev server.
    debouncedChange().catch((err: unknown) => {
      log.error(`Watch handler failed: ${errorMessage(err)}`);
    });
  });
  return watcher;
}

// ─── Dev server ─────────────────────────────────────────────────────────────

/** Locate the pre-built default aai-ui client (served when no custom client.tsx). */
function resolveDefaultClientDir(): string {
  const require = createRequire(import.meta.url);
  let pkgPath: string;
  try {
    pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
  } catch (err) {
    throw new Error(
      `Could not locate the default client UI (${errorMessage(err)}) — ` +
        "is @alexkroman1/aai-ui installed? Try reinstalling dependencies (pnpm install).",
      { cause: err },
    );
  }
  return path.join(path.dirname(pkgPath), "dist", "default-client");
}

export type DevServerOptions = {
  cwd: string;
  port: number;
};

/**
 * Vite dev-server config for the client SPA. Extracted so the proxy wiring
 * is unit-testable: `/websocket` MUST proxy with `ws: true` or `aai dev`
 * with a `client.tsx` serves a page whose WebSocket never connects.
 *
 * `strictPort` because the reported URL is `http://localhost:<port>` —
 * without it, Vite silently binds port+N when the port is busy and the
 * printed/JSON-returned URL points at whatever else was listening.
 */
export function viteDevConfig(
  cwd: string,
  vitePort: number,
  backendPort: number,
): import("vite").InlineConfig {
  const target = `http://localhost:${backendPort}`;
  return {
    root: cwd,
    plugins: [fallbackHtmlPlugin(cwd)],
    server: {
      port: vitePort,
      strictPort: true,
      proxy: {
        "/health": target,
        "/websocket": { target, ws: true },
      },
    },
  };
}

/**
 * Start the dev server for a directory-based agent.
 *
 * Returns a cleanup function to shut down the server and watchers.
 */
export async function startDevServer(opts: DevServerOptions): Promise<() => Promise<void>> {
  const { cwd, port } = opts;

  const { createRuntime, createServer } = await import("@alexkroman1/aai/runtime");

  const hasClient = existsSync(path.join(cwd, "client.tsx"));
  // With a client, Vite owns the user-requested port and proxies to the
  // backend. Prefer port+1 for the backend but fall back to any nearby free
  // port instead of failing with EADDRINUSE (the old `port + 1` was blind).
  const backendPort = hasClient ? await getPort({ port: portNumbers(port + 1, port + 100) }) : port;
  const vitePort = port;

  // When no custom client.tsx, serve the pre-built default aai-ui client.
  // Resolved once — the location can't change for the process lifetime.
  const clientDirOpt = hasClient ? {} : { clientDir: resolveDefaultClientDir() };

  // One incremental build context + one eval memo for the server's lifetime —
  // reuse across watcher events is what makes restarts fast.
  const devBuilder = createDevWorkerBuilder(cwd);
  const evaluateWorker = createWorkerEvaluator(cwd);

  /** Full build sequence, shared by initial startup and every restart. */
  async function buildServer(): Promise<AgentServer> {
    const agentDef = await loadAgentDefWith(cwd, devBuilder, evaluateWorker);
    const env = await resolveAgentEnv(cwd, agentDef);
    // Self-hosted only: let provider credentials exported in the shell reach
    // the resolvers without entering `ctx.env`. Keeping them out of `ctx.env`
    // preserves dev/prod parity — agent code sees the same keys it will see on
    // the platform (only what `.env` / `aai secret put` declares) and so can't
    // come to depend on a host-level variable that won't exist there.
    const providerEnv = withHostCredentialFallback(env);
    const runtime = createRuntime({ agent: agentDef, env, providerEnv });
    return createServer({
      runtime,
      name: agentDef.name,
      // Makes host mode *available* in the dev server — it stays off unless
      // AAI_ALLOW_HOST is set, since a `?host=1` client supplies its own agent
      // definition and would otherwise be able to spend the operator's
      // provider credentials unauthenticated. Harnesses (e.g. tau2) opt in.
      //
      // `resolveServerEnv` only surfaces keys declared in `.env`, so the gate
      // is read from the shell explicitly — otherwise host mode would be
      // unreachable for anyone who exports it the usual way. Host sessions
      // open their own provider connections, so they get `providerEnv`.
      env: hostModeEnv(providerEnv),
      // Host sessions inherit this agent's stt/llm/tts pipeline config.
      hostBaseAgent: agentDef,
      ...clientDirOpt,
    });
  }

  // `restarting` starts true: startup counts as an in-flight "restart", so a
  // change event landing during the multi-second boot queues a restart
  // instead of racing the initial build.
  let restarting = true;
  let pendingRestart = false;
  let closed = false;
  let currentServer: AgentServer;

  function kickRestart(): void {
    // A change during an in-flight restart must not be dropped: flag it so
    // restart() loops once more with the newest files. Otherwise the final
    // save is silently ignored (stale server), or — if the in-flight restart
    // failed on a mid-edit syntax error — the server stays down entirely.
    if (restarting) {
      pendingRestart = true;
      return;
    }
    restarting = true;
    // restart() catches its own build/listen failures, but a throw from an
    // unexpected path must still be logged and must still clear `restarting`
    // (catch-then-finally = try/finally semantics), or watching wedges forever.
    void restart()
      .catch((err: unknown) => {
        log.error(`Restart failed: ${errorMessage(err)}`);
      })
      .finally(() => {
        restarting = false;
      });
  }

  // Install the watcher BEFORE the initial build: `ignoreInitial` means an
  // edit saved during startup (bundle + listen + Vite boot) would otherwise
  // never fire an event and the dev server would serve stale code until the
  // next save.
  const watcher = watchDirectory(cwd, kickRestart);

  let viteServer: ViteDevServer | undefined;
  try {
    currentServer = await buildServer();
    // Loopback by default (the dev server has no auth). AAI_DEV_HOST is the
    // escape hatch for setups where loopback isn't reachable — e.g. running
    // `aai dev` inside a container and connecting from the host.
    await currentServer.listen(backendPort, devBindHost());

    if (hasClient) {
      const { createServer: createViteServer } = await import("vite");
      viteServer = await createViteServer(viteDevConfig(cwd, vitePort, backendPort));
      await viteServer.listen();
      // Post-listen socket errors would otherwise be an unhandled 'error'
      // event. (The backend AgentServer keeps its own 'error' listener from
      // listen(), and exposes no event surface to add logging here.)
      viteServer.httpServer?.on("error", (err) => {
        log.error(`Vite dev server error: ${errorMessage(err)}`);
      });
    }
  } catch (err) {
    // Startup failed — the watcher was already opened and the esbuild
    // context holds a service child process; don't leak either.
    await watcher.close().catch(() => undefined);
    await devBuilder.dispose().catch(() => undefined);
    await viteServer?.close().catch(() => undefined);
    throw err;
  }

  // Startup complete: release the queue, and run the one restart an edit
  // saved during boot asked for.
  restarting = false;
  if (pendingRestart) kickRestart();

  async function restart(): Promise<void> {
    do {
      pendingRestart = false;
      await restartOnce();
    } while (pendingRestart && !closed);
  }

  async function restartOnce(): Promise<void> {
    // Build the replacement server FIRST (the slow part — full bundle +
    // runtime construction). The old server keeps serving live sessions the
    // whole time, and a failed build (e.g. a mid-edit syntax error) leaves it
    // running instead of leaving the port dead until the next save.
    let newServer: AgentServer;
    try {
      newServer = await buildServer();
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)} (previous server still running)`);
      return;
    }
    // The cleanup fn may have run while we were rebuilding — don't leave a
    // freshly-built server orphaned (leaked port / hung event loop).
    if (closed) {
      await newServer.close().catch(() => undefined);
      return;
    }
    // The old server holds the port, so it must close before the new one
    // listens — the down-window is now just this close+listen swap.
    try {
      await currentServer.close();
    } catch {
      /* ignore */
    }
    try {
      await listenWithRetry(newServer);
      currentServer = newServer;
      if (closed) {
        // Cleanup raced with the swap: it closed the old server, so shut the
        // new one down too rather than leaving it listening forever.
        await newServer.close().catch(() => undefined);
        return;
      }
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)} — dev server is down; save a file to retry.`);
      await newServer.close().catch(() => undefined);
    }
  }

  /**
   * Listen with a few short-backoff retries. During the close→listen swap the
   * port is momentarily free, so another process can snatch it (or the OS can
   * hold it in TIME_WAIT); one blind attempt would leave the dev server down
   * until the next file change.
   */
  async function listenWithRetry(server: AgentServer): Promise<void> {
    const LISTEN_ATTEMPTS = 3;
    const LISTEN_RETRY_DELAY_MS = 250;
    for (let attempt = 1; ; attempt++) {
      try {
        // Bind host matches the initial listen — a restart must not silently
        // widen the dev server's exposure.
        await server.listen(backendPort, devBindHost());
        return;
      } catch (err) {
        if (attempt >= LISTEN_ATTEMPTS || closed) throw err;
        await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_DELAY_MS));
      }
    }
  }

  // Idempotent: SIGINT followed by SIGTERM must not run the teardown twice
  // concurrently (double server close → ERR_SERVER_NOT_RUNNING noise, double
  // runtime shutdown). The second call joins the in-flight teardown.
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      closed = true;
      // Each close is best-effort: one failing must not leak the others.
      await watcher.close().catch(() => undefined);
      await devBuilder.dispose().catch(() => undefined);
      await viteServer?.close().catch(() => undefined);
      await currentServer.close().catch(() => undefined);
    })();
    return cleanupPromise;
  };
}
