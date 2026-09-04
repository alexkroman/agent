// Copyright 2025 the AAI authors. MIT license.
/**
 * Dev server for directory-based agents.
 *
 * Imports agent.ts directly for the full agent definition,
 * builds a runtime, and starts an HTTP+WebSocket server. File watching is
 * opt-in via `AAI_DEV_WATCH=1` (see devWatchEnabled). Optionally runs Vite for
 * client SPA HMR.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { agentConfigWarnings } from "@alexkroman1/aai/manifest";
import { omitUndefined, plural } from "@alexkroman1/aai/utils";
// One static import: the runtime barrel is already loaded for the helpers
// below, so a dynamic import inside startDevServer would defer nothing.
import {
  type AgentServer,
  createRuntime,
  createRuntimeServer,
  ensureSessionStateSchema,
  ensureWorkflowJournalSchema,
  type Logger,
  requiredProviderEnvVars,
  withHostCredentialFallback,
} from "@alexkroman1/aai-runtime";
import {
  createMemoryJournal,
  handleWorkflowRequest,
  publishStepEnv,
  WORKFLOW_DATA_DIR_ENV,
} from "@alexkroman1/aai-runtime/internal";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { type FSWatcher, watch } from "chokidar";
import getPort, { portNumbers } from "get-port";
import pDebounce from "p-debounce";
import type { ViteDevServer } from "vite";
import { createWorkerEvaluator } from "./_bundler.ts";
import { ensureApiKey } from "./_config.ts";
import { createDevLogger, devBindHost, devWatchEnabled, hostModeEnv } from "./_dev-env.ts";
import { createRestartSupervisor } from "./_dev-restart.ts";
import { createDevTypecheck } from "./_dev-typecheck.ts";
import { viteDevConfig } from "./_dev-vite-config.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { notify, outputSilenced } from "./_ui.ts";
import { errorCode, errorMessage } from "./_utils.ts";
import { buildWorker } from "./worker-bundler.ts";

// ─── Env loading ────────────────────────────────────────────────────────────

/**
 * Warnings about the agent's credentials, computed against the `.env`-derived
 * env and the shell. Pure so it is directly testable; `resolveAgentEnv` logs
 * each entry. Three cases, in increasing subtlety:
 *
 * - a provider key found nowhere → the first session will fail auth;
 * - a provider key found only in the shell → works here (the
 *   `withHostCredentialFallback` ergonomic) but is invisible to `aai deploy`,
 *   which uploads `.env` — the classic "works locally, dead on deploy";
 * - a declared `requiredEnv` key absent from `.env` → `ctx.env` won't contain
 *   it at all: custom keys never fall back to the shell, so a shell export
 *   can't mask one that would be missing both here and after deploy.
 */
export function agentEnvWarnings(
  // `page` because a workflow app needs no provider credential at all — see
  // `requiredProviderEnvVars`. Omitted here, every static agent was warned
  // about an AssemblyAI key it never dials.
  agentDef: Pick<AgentDef, "stt" | "llm" | "tts" | "s2s" | "requiredEnv" | "page">,
  env: Record<string, string>,
  shellEnv: Record<string, string | undefined> = process.env,
): string[] {
  // Derived from the provider registries rather than matched against hardcoded
  // kinds, so a new provider needs no change here and nothing is missed. (The
  // previous check looked only at `stt`/`llm` and only for AssemblyAI.)
  const required = requiredProviderEnvVars(agentDef);
  const warnings: string[] = [];

  const missing = required.filter((name) => !(env[name] || shellEnv[name]));
  if (missing.length > 0) {
    warnings.push(
      `Missing provider ${plural(missing.length, "credential")}: ${missing.join(", ")}. ` +
        `Set ${plural(missing.length, "it", "them")} in .env or the environment.`,
    );
  }

  const shellOnly = required.filter((name) => !env[name] && shellEnv[name]);
  if (shellOnly.length > 0) {
    warnings.push(
      `${shellOnly.join(", ")} resolved from your shell, not .env — ` +
        `deployed agents won't have ${plural(shellOnly.length, "it", "them")}. ` +
        `Declare ${plural(shellOnly.length, "it", "them")} in .env before \`aai publish\`.`,
    );
  }

  const declared = (agentDef.requiredEnv ?? []).filter((name) => !env[name]);
  if (declared.length > 0) {
    warnings.push(
      `Missing requiredEnv ${plural(declared.length, "key")} declared by the agent: ` +
        `${declared.join(", ")}. Set ${plural(declared.length, "it", "them")} in .env — ` +
        `ctx.env will not contain ${plural(declared.length, "it", "them")} otherwise.`,
    );
  }
  return warnings;
}

async function resolveAgentEnv(root: string, agentDef: AgentDef): Promise<Record<string, string>> {
  const env = await resolveServerEnv(root);

  // Only AssemblyAI's key has a setup flow of its own (it doubles as the
  // platform credential), so that one falls back to the logged-in key.
  //
  // A shell-exported key is deliberately checked FIRST and left out of `env`:
  // `withHostCredentialFallback` (below, in `buildServer`) already routes it
  // to the provider resolvers without letting it into `ctx.env`, and
  // `agentEnvWarnings` flags it as shell-only so the "works here, dead after
  // deploy" case stays visible. Without this check `aai dev` would hard-fail
  // on a missing LOGIN for a developer whose key is exported the usual way,
  // since `ensureApiKey` reads the login key and nothing else.
  //
  // `"local-session"` is what keeps the FAILURE credential-shaped: nothing
  // here needs a platform account, so the refusal names `.env` and a shell
  // export before `aai login`. See {@link ApiKeyUse}.
  const required = requiredProviderEnvVars(agentDef);
  const hasShellKey = Boolean(process.env.ASSEMBLYAI_API_KEY);
  if (required.includes("ASSEMBLYAI_API_KEY") && !env.ASSEMBLYAI_API_KEY && !hasShellKey) {
    env.ASSEMBLYAI_API_KEY = await ensureApiKey(undefined, "local-session");
  }

  // Anything still unresolved would otherwise surface as an auth failure on
  // the first session (or a deploy-time rejection) — warn now. Through
  // `notify`, not `log.warn`: `aai dev` is long-running, so JSON mode (which a
  // pipe auto-selects) has already silenced `log` and the first session then
  // fails auth with nothing having said why. See this package's CLAUDE.md.
  for (const warning of agentEnvWarnings(agentDef, env)) notify("warn", warning);
  // The config's own warnings — a TTS/S2S voice outside the catalog, which is
  // otherwise reported by nothing until the first session is silent.
  for (const warning of agentConfigWarnings(agentDef)) notify("warn", warning);
  return env;
}

// ─── Agent loading ──────────────────────────────────────────────────────────

/**
 * Load the agent definition by bundling agent.ts (and all its local imports)
 * into a single ESM file, then importing that. A raw `import(agent.ts?t=...)`
 * only cache-busts agent.ts itself — transitive imports (./tools.ts, etc.)
 * stay in Node's ESM registry, so edits to them are ignored on reload.
 * Bundling picks them up.
 *
 * The bundle comes from the same Vite pass deploy runs (`buildWorker`), so
 * dev and deploy can't drift; a warm rebuild is well under 100ms. Compile
 * errors in the agent's code propagate — the restart loop reports them and
 * keeps the old server. Evaluation goes through the memoizing evaluator so
 * a no-op save doesn't leak another module into the ESM registry.
 *
 */
export async function loadWorker(
  cwd: string,
  evaluate: (code: string) => Promise<AgentDef>,
): Promise<AgentDef> {
  // `runtime: false`: the dev server builds its runtime in-process from the
  // same installed SDK the wrapper would bundle, and inlining the runtime +
  // provider SDKs on every file-watch rebuild would make reloads multi-second.
  return evaluate(await buildWorker(cwd, { runtime: false }));
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
    notify("info", "File change detected, restarting...");
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
    notify(
      "error",
      `File watcher error: ${errorMessage(err)}.${hint} ` +
        "Auto-restart on file changes may have stopped; restart `aai dev` after fixing.",
    );
  });
  watcher.on("all", () => {
    // debouncedChange resolves after onChange runs — a throw there must not
    // become an unhandled rejection that kills the dev server.
    debouncedChange().catch((err: unknown) => {
      notify("error", `Watch handler failed: ${errorMessage(err)}`);
    });
  });
  return watcher;
}

// ─── Dev server ─────────────────────────────────────────────────────────────

export type DevServerOptions = {
  cwd: string;
  port: number;
  /**
   * Restart on a file change. Omitted, `AAI_DEV_WATCH` decides — see
   * {@link devWatchEnabled} for why watching is opt-in at all.
   */
  watch?: boolean | undefined;
};

/**
 * Start the dev server for a directory-based agent.
 *
 * Returns a cleanup function to shut down the server and watchers.
 */
export async function startDevServer(opts: DevServerOptions): Promise<() => Promise<void>> {
  const { cwd, port } = opts;

  // Where this project's local workflow state lives — the uploads a databaseless
  // agent's runs read (`aai-runtime/workflow-data-dir.ts`).
  //
  // Set HERE, once, before anything builds a server: `installWorkflowSupport`
  // reads it out of `process.env` on every `createRuntimeServer`, and unset it falls
  // back to a per-PROCESS `tmpdir()/aai-workflow-data-<pid>`. The directory
  // beside the project is what makes a restart a SAVE rather than a new
  // deployment — the same upload's bytes come back byte-identical, which that
  // module documents as measured and which nothing had set since
  // `configureWorkflowWorld` (which wrote this for us) went with the DevKit.
  //
  // An exported value WINS, like `PUBLIC_URL` below: a developer pointing
  // several checkouts at one directory has said so deliberately.
  if (!process.env[WORKFLOW_DATA_DIR_ENV]?.trim()) {
    process.env[WORKFLOW_DATA_DIR_ENV] = path.join(cwd, ".workflow-data");
  }

  const hasClient = existsSync(path.join(cwd, "client.tsx"));
  // With a client, Vite owns the user-requested port and proxies to the
  // backend. Prefer port+1 for the backend but fall back to any nearby free
  // port instead of failing with EADDRINUSE (the old `port + 1` was blind).
  const backendPort = hasClient ? await getPort({ port: portNumbers(port + 1, port + 100) }) : port;
  const vitePort = port;

  // When no custom client.tsx, serve the pre-built default aai-ui client.
  // Resolved once — the location can't change for the process lifetime.
  const clientDirOpt = hasClient ? {} : { clientDir: defaultClientDir() };

  // One eval memo for the server's lifetime — a no-op save re-uses the
  // previously evaluated AgentDef instead of leaking another ESM module.
  const evaluateWorker = createWorkerEvaluator();

  const devLogger: Logger = createDevLogger(outputSilenced());

  /**
   * Whether the session-state tables have been ensured this process.
   *
   * Once per dev server rather than per restart: a rebuild replaces the routes,
   * not the storage behind them, and re-running the DDL on every file save would
   * be two round trips per keystroke burst.
   */
  let sessionSchemaEnsured = false;

  /**
   * Where a databaseless project's durable runs live for this whole `aai dev`.
   *
   * STORAGE per PROCESS, CODE per BUILD — the split the deleted DevKit world
   * made on our behalf. Every save rebuilds the runtime (that is what reloads a
   * workflow BODY) and a rebuild handed no journal builds a fresh one inside the
   * engine, so a run started before a save was gone after it and
   * `GET /workflows/runs/:id` 404'd for a run the page was still polling.
   * Deliberately NOT the whole client: reusing build 1's would freeze every body
   * at build 1. `RuntimeOptions.journal` carries the rest, including what this
   * does NOT restore (a `ctx.sleep` parked across the save still needs a
   * delivery) and why it cannot demote a postgres or platform journal.
   */
  const journal = createMemoryJournal();

  /** Full build sequence, shared by initial startup and every restart. */
  async function buildServer(): Promise<AgentServer> {
    const agentDef = await loadWorker(cwd, evaluateWorker);
    const env = await resolveAgentEnv(cwd, agentDef);

    // A project with a `DATABASE_URL` puts session state in Postgres, and the
    // tables come with whoever OWNS that database — which under `aai dev` is the
    // developer, with no migration step anywhere to hang the DDL off. Without
    // this every session died at start with a fatal 1011 and the reason
    // (`relation "aai_session_events" does not exist`) only in this log. Before
    // the runtime opens its own pool from the same URL, so the first session
    // cannot race the DDL.
    if (env.DATABASE_URL && !sessionSchemaEnsured) {
      sessionSchemaEnsured = true;
      await ensureSessionStateSchema({ url: env.DATABASE_URL, logger: devLogger });
      // And the durable-run JOURNAL, which had no creator at all: the boot line
      // said `runStore: "postgres"` and the first run died on `42P01 relation
      // "aai_workflow_runs" does not exist`.
      await ensureWorkflowJournalSchema({ url: env.DATABASE_URL, logger: devLogger });
    }

    // What a `"use step"` body reads with `stepEnv()`. The AGENT env, not
    // `providerEnv` below: a step must see exactly what `.env` and
    // `aai secret put` declare, or a shell-exported key would make a workflow
    // work here and fail after a deploy with nothing having said so.
    publishStepEnv(env);

    // Self-hosted only: let provider credentials exported in the shell reach
    // the resolvers without entering `ctx.env`. Keeping them out of `ctx.env`
    // preserves dev/prod parity — agent code sees the same keys it will see on
    // the platform (only what `.env` / `aai secret put` declares) and so can't
    // come to depend on a host-level variable that won't exist there.
    const providerEnv = withHostCredentialFallback(env);
    const runtime = createRuntime({
      agent: agentDef,
      env,
      providerEnv,
      logger: devLogger,
      // The one thing a rebuild must NOT rebuild — see the declaration above.
      journal,
      // What `ctx.workflows.publicWebhookUrl(token)` mints from. The BACKEND
      // port, not the port the developer opens: with a `client.tsx` Vite owns
      // that one and proxies only the browser-facing surface, and the DevKit's
      // `/.well-known/workflow/v1/*` routes are deliberately not in that table
      // (a queue callback is dialled on loopback, never by a page) — so a URL
      // naming the Vite port would 404 on delivery. `PUBLIC_URL` overrides for
      // the case that actually needs one: a tunnel, when a real third party has
      // to reach a webhook on this machine.
      publicUrl: process.env.PUBLIC_URL?.trim() || `http://localhost:${backendPort}`,
    });

    return createRuntimeServer({
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
      // Served pre-connection via GET /client-config.
      greeting: agentDef.greeting,
      // A workflow app's declaration, honoured by the dev server exactly as the
      // deployed guest honours it: `/websocket` is declined with a reason and
      // telephony defaults off. Parity matters more here than usual, because a
      // page mounted with `client()` by mistake fails identically in both places
      // instead of only after a deploy.
      ...omitUndefined({ page: agentDef.page }),
      // The PLATFORM's delivery door, and `aai dev` deliberately supplies no
      // `allowRemote`, so it answers 401. That is correct rather than an
      // omission: there is no queue outside this process — the engine's
      // dispatcher is a `setTimeout` here — so a delivery arriving from anywhere
      // would be a caller this composition cannot vouch for.
      //
      // Mounted anyway, rather than skipped, so the route ANSWERS on the same
      // door it answers on when deployed. A path that 404s in dev and 401s in
      // production is the kind of difference a feature is developed against.
      //
      // `deliver` is a THUNK and `logger` is `devLogger`, both spelled the way
      // `agent-server.ts` and the guest's `harness-manage.ts` spell them so the
      // three mounts of this one door cannot drift. The logger matters here in
      // particular: the door's fallback is `consoleLogger`, whose `info` is
      // `console.log`, and `aai dev --json` owes stdout exactly one line.
      request: (req, res, url, method) =>
        handleWorkflowRequest(req, res, url, method, {
          deliver: () => runtime.deliverWorkflow,
          logger: devLogger,
        }),
      ...clientDirOpt,
    });
  }

  let viteServer: ViteDevServer | undefined;
  let watcher: FSWatcher | undefined;

  // The restart state machine — queueing, build-before-close ordering, listen
  // retries, teardown races — lives in _dev-restart.ts, driven by the three
  // operations below. Its invariants are specced there directly; this function
  // only supplies the real build/listen/close and the surrounding wiring.
  const supervisor = createRestartSupervisor<AgentServer>({
    build: buildServer,
    // Bind host matches the initial listen — a restart must not silently
    // widen the dev server's exposure.
    listen: (server) => server.listen(backendPort, devBindHost()),
    close: (server) => server.close(),
    notify,
    teardown: async () => {
      // Each close is best-effort: one failing must not leak the others.
      await watcher?.close().catch(() => undefined);
      await viteServer?.close().catch(() => undefined);
    },
  });

  // Install the watcher BEFORE the initial build: `ignoreInitial` means an
  // edit saved during startup (bundle + listen + Vite boot) would otherwise
  // never fire an event and the dev server would serve stale code until the
  // next save. Undefined unless AAI_DEV_WATCH is set — see devWatchEnabled.
  // The supervisor starts queueing, so an event landing mid-boot is held.
  // Typecheck at boot and on every restart, in the background. `aai dev` is the
  // only command that did not, which made every compile-time diagnostic this
  // SDK writes conditional on an editor being open — see `_dev-typecheck.ts`.
  const devTypecheck = createDevTypecheck(cwd);
  devTypecheck.request();
  watcher = devWatchEnabled(opts.watch)
    ? watchDirectory(cwd, () => {
        devTypecheck.request();
        supervisor.request();
      })
    : undefined;

  // Set once the backend has bound but before the supervisor owns it: if Vite
  // then fails to boot, this is the only handle on a server already holding
  // the port, and startDevServer throws. It used to leak.
  let boundServer: AgentServer | undefined;
  try {
    const initialServer = await buildServer();
    // Loopback by default (the dev server has no auth). AAI_DEV_HOST is the
    // escape hatch for setups where loopback isn't reachable — e.g. running
    // `aai dev` inside a container and connecting from the host.
    await initialServer.listen(backendPort, devBindHost());
    boundServer = initialServer;

    if (hasClient) {
      const { createServer: createViteServer } = await import("vite");
      viteServer = await createViteServer(viteDevConfig(cwd, vitePort, backendPort));
      await viteServer.listen();
      // Post-listen socket errors would otherwise be an unhandled 'error'
      // event. (The backend AgentServer keeps its own 'error' listener from
      // listen(), and exposes no event surface to add logging here.)
      viteServer.httpServer?.on("error", (err) => {
        notify("error", `Vite dev server error: ${errorMessage(err)}`);
      });
    }

    // Startup complete: release the queue, and run the one restart an edit
    // saved during boot asked for. Last, so nothing above can rebuild under
    // a half-built server.
    supervisor.adopt(initialServer);
  } catch (err) {
    // Startup failed — the watcher and Vite were already opened; don't leak
    // them, nor a backend that bound before Vite blew up. The supervisor
    // never adopted anything, so its own close() covers the teardown set only.
    await supervisor.close();
    await boundServer?.close().catch(() => undefined);
    throw err;
  }

  return supervisor.close;
}
