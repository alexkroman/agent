// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start` — serve a BUILT agent from a plain Node process.
 *
 * The deployment counterpart of `aai dev`: no file watching, no Vite, no
 * typecheck, no source evaluation. It loads the artifact `aai build` left at
 * {@link WORKER_ARTIFACT_REL} — the same one `aai publish` uploads and the
 * managed platform runs — so a self-hosted agent and a deployed one cannot
 * behave differently.
 *
 * ## Why this is a command rather than a file in every project
 *
 * It used to be `scaffold/server.mjs`, ~300 lines of boot that `aai init`
 * copied into every scaffolded project: worker load, env resolution, schema
 * DDL, client-directory probing, error classification, listen, signal
 * handlers. Shipping that as source made each of those a fact a USER's
 * repository asserted, so improving any of them reached only projects
 * scaffolded afterwards, and an existing project silently kept the old
 * behaviour with nothing to report the drift.
 *
 * Every framework that solved this solved it the same way: the boot belongs to
 * the framework and the project holds none of it. Next has `next start` and
 * generates a `server.js` for `output: "standalone"` rather than asking anyone
 * to write one. Nitro's default production preset is `node-server`, emitted
 * into the build directory. The custom server is a documented opt-out, not the
 * default everyone inherits — and here that opt-out is
 * {@link createProjectServer}, which builds the server and binds nothing.
 *
 * ## Why the CLI rather than the runtime
 *
 * Booting a project needs three things at once: the runtime, the project's
 * `.aai/` layout, and the prebuilt browser client. Only this package depends on
 * all three — `aai-runtime` may not import `@alexkroman1/aai-ui`, and
 * konsistent's `runtime-package-boundary` carries the install-weight argument
 * for why that stays true. `client-dir.ts`'s own module doc records that this
 * composition has always lived in an ENTRY POINT; this is that entry point,
 * owned by the framework instead of copied into each project.
 *
 * The cost, stated because it is real: `npm start` needs `@alexkroman1/aai-cli`
 * installed, so a production image carries a build toolchain it does not run.
 * Next makes the same trade — `next` is a `dependency`, not a `devDependency` —
 * and it is why the scaffold moves this package to `dependencies`.
 */

import cluster from "node:cluster";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import {
  type AgentServer,
  createAgentServer,
  ensureSessionStateSchema,
  ensureWorkflowJournalSchema,
} from "@alexkroman1/aai-runtime";
import { consoleLogger, withHostCredentialFallback } from "@alexkroman1/aai-runtime/internal";
import { startTracing } from "@alexkroman1/aai-runtime/tracing";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { resolveDenoRunCode } from "./_run-code-deno.ts";
import { DEPLOY_ENV_FILES, resolveServerEnv } from "./_server-common.ts";
import { listenServer } from "./_start-cluster.ts";
import { runStart, type StartResult } from "./_start-run.ts";
import { processLink } from "./_start-worker.ts";
import { DEFAULT_DRAIN_TIMEOUT_S, nodeCluster, SLOT_ENV, SLOTS_ENV } from "./_start-workers.ts";
import { stopProjectServer } from "./_stop-server.ts";
import { defaultUi } from "./_ui.ts";

export { CLIENT_ARTIFACT_REL } from "./_artifacts.ts";

/** The port `aai start` binds when neither an argument nor `PORT` says otherwise. */
export const DEFAULT_START_PORT = 3000;

/** Options for {@link createProjectServer} and {@link executeStart}. */
export interface ProjectServerOptions {
  /** Project root — the directory holding `agent.ts` and `.aai/`. */
  cwd: string;
  /** Port to bind. Defaults to `PORT`, then {@link DEFAULT_START_PORT}. */
  port?: number | undefined;
  /**
   * Address to bind. Defaults to `HOST`, then loopback.
   *
   * Loopback is deliberate: this server has no request authentication of its
   * own, so exposing it is an explicit act, and `HOST=0.0.0.0` is how a
   * container says so. An EMPTY `HOST` means unset, not "every interface".
   */
  host?: string | undefined;
  /**
   * Processes to serve from, one per CPU core worth using (see
   * `_start-workers.ts`). Defaults to 1. Only {@link executeStart} reads it.
   */
  workers?: number | undefined;
  /** With `workers > 1`: how long a drain lets calls finish (ms). Default 300 s. */
  drainTimeoutMs?: number | undefined;
  /** With `workers > 1`: calls a worker may hold before new ones get 503. Default unlimited. */
  maxCallsPerWorker?: number | undefined;
}

/** The built worker's path, or a throw saying what to run. */
function builtAgentPath(cwd: string): string {
  const workerPath = path.join(cwd, WORKER_ARTIFACT_REL);
  if (!existsSync(workerPath)) {
    throw new Error(
      `No built agent at ${WORKER_ARTIFACT_REL}. ` +
        "Run `aai build` first — the scaffold's `prestart` script normally does it for you.",
    );
  }
  return workerPath;
}

/** The address `aai start` binds: the option, then `PORT`/`HOST`, then the defaults. */
function listenAddress(options: ProjectServerOptions): { port: number; host: string | undefined } {
  return {
    port: options.port ?? Number(process.env.PORT ?? DEFAULT_START_PORT),
    host: options.host ?? (process.env.HOST?.trim() || undefined),
  };
}

/**
 * Load the built agent, or fail saying what to run.
 *
 * A `file:` URL rather than a relative specifier, because on Windows a bare
 * POSIX-looking path is not a valid module specifier.
 */
export async function loadBuiltAgent(cwd: string): Promise<AgentDef> {
  const worker = (await import(pathToFileURL(builtAgentPath(cwd)).href)) as { default: AgentDef };
  return worker.default;
}

/**
 * Static assets to serve at `/`: this project's own built UI when it has one,
 * otherwise the prebuilt default client that ships inside `@alexkroman1/aai-ui`.
 *
 * A `client.tsx` that has not been BUILT is worth saying out loud — the server
 * would otherwise serve the default UI and look like it had ignored the file.
 */
function resolveClientDir(cwd: string): string {
  const built = path.join(cwd, CLIENT_ARTIFACT_REL);
  if (existsSync(path.join(built, "index.html"))) return built;
  if (existsSync(path.join(cwd, "client.tsx"))) {
    defaultUi.log.warn("client.tsx is not built — serving the default UI. Run `aai build` first.");
  }
  return defaultClientDir();
}

/**
 * Build this project's {@link AgentServer} WITHOUT binding a socket.
 *
 * The seam a custom server is written against, and the one a serverless host
 * needs: Vercel documents `export default <http.Server>` as its Node WebSocket
 * shape and binds the socket itself, so such a host takes `AgentServer.node`
 * and never calls `listen()`. `aai build --target vercel` emits an entry that
 * does exactly this, so nothing host-specific is committed to a project.
 *
 * @example
 * ```ts no-check
 * // The entry `aai build --target vercel` bundles into
 * // `.vercel/output/functions/index.func/` — `no-check` because this file
 * // lives in the USER's project, where `@alexkroman1/aai-cli/start` resolves;
 * // it cannot resolve from inside this package.
 * import { createProjectServer } from "@alexkroman1/aai-cli/start";
 *
 * const server = (await createProjectServer({ cwd: import.meta.dirname })).node;
 *
 * export default function handler(req, res) {
 *   server.emit("request", req, res);
 * }
 * ```
 */
export async function createProjectServer(options: ProjectServerOptions): Promise<AgentServer> {
  const { agent, env } = await loadProject(options.cwd);
  return buildProjectServer(options.cwd, agent, env);
}

/** The built agent and its env — what every way of serving a project starts from. */
async function loadProject(cwd: string): Promise<{ agent: AgentDef; env: Record<string, string> }> {
  const agent = await loadBuiltAgent(cwd);
  // `.env.example` counts as a declaration here — see `DEPLOY_ENV_FILES`, which
  // is what lets a container ship no `.env` and supply the values as real
  // environment variables.
  const env = await resolveServerEnv(cwd, undefined, DEPLOY_ENV_FILES);
  return { agent, env };
}

async function buildProjectServer(
  cwd: string,
  agent: AgentDef,
  env: Record<string, string>,
): Promise<AgentServer> {
  if (env.DATABASE_URL) {
    // A project with a `DATABASE_URL` puts session state and durable runs in
    // Postgres, and those tables come with whoever OWNS the database — which
    // for a self-hosted agent is the operator, with no migration step anywhere
    // to hang the DDL off. Applied before the runtime opens its own pool on the
    // same URL, so the first session cannot race it. Without this the server
    // starts, reports `durable: true`, and every session dies at start with the
    // real reason (`relation "aai_session_events" does not exist`) visible only
    // in this process's log.
    await ensureSessionStateSchema({ url: env.DATABASE_URL, logger: console });
    await ensureWorkflowJournalSchema({ url: env.DATABASE_URL, logger: console });
  } else if (cluster.isPrimary) {
    // Say that this process is the only place the state lives, because the next
    // thing an operator does with a container is run two of them. It is not
    // only about restarts: the browser reconnects with `?sessionId=`, so a
    // reconnect landing on another replica resumes a session that replica has
    // never heard of, and the agent's context is gone mid-call.
    defaultUi.log.warn(
      "No DATABASE_URL: session state and durable runs live in THIS process's memory.\n" +
        "One replica is fine. Behind a load balancer, enable sticky sessions so a reconnect " +
        "(the client re-dials with ?sessionId=) reaches the same process — or set DATABASE_URL " +
        "and let every replica share the state.",
    );
  }

  return createAgentServer({
    agent,
    env,
    // Provider credentials may ALSO arrive straight from the environment
    // without being declared, and without becoming `ctx.env` — the ordinary way
    // to hand ASSEMBLYAI_API_KEY to a container. Anything in `env` still wins,
    // which is what keeps dev/prod parity: agent code sees only what `.env` and
    // `aai secret put` declare, so it cannot come to depend on a host-level
    // variable that will not exist on the platform.
    providerEnv: withHostCredentialFallback(env),
    clientDir: resolveClientDir(cwd),
    // Where this server is reachable from OUTSIDE, which behind a proxy is not
    // the socket it binds — so it is never derived from PORT/HOST.
    // `ctx.workflows.publicWebhookUrl()` is the only reader; without it that
    // call throws rather than minting a `http://localhost:3000` URL a payment
    // provider will try, days later, and fail.
    ...(process.env.PUBLIC_URL?.trim() ? { publicUrl: process.env.PUBLIC_URL.trim() } : {}),
    // `AAI_RUN_CODE=deno` gives `run_code` a zero-permission Deno process to run
    // in (`_run-code-deno.ts`); unset, it refuses as it does under `aai dev`.
    ...omitUndefined({ runCode: resolveDenoRunCode(consoleLogger) }),
  });
}

export type { StartResult } from "./_start-run.ts";

/**
 * Serve the built agent and keep serving it: bind, announce, and shut down
 * cleanly on a signal — from one process, or with `workers > 1` from a primary
 * routing to that many (`_start-workers.ts`). The logic is `runStart`
 * (`_start-run.ts`); this hands it the real process.
 */
export async function executeStart(options: ProjectServerOptions): Promise<StartResult> {
  const { cwd } = options;
  const { port, host } = listenAddress(options);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  return runStart(
    {
      port,
      host,
      workers: options.workers ?? 1,
      drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_S * 1000,
      maxCallsPerWorker: options.maxCallsPerWorker ?? Number.POSITIVE_INFINITY,
    },
    {
      isWorker: cluster.isWorker,
      slot: () => ({ slot: Number(process.env[SLOT_ENV]), slots: Number(process.env[SLOTS_ENV]) }),
      load: () => loadProject(cwd),
      build: ({ agent, env }) => buildProjectServer(cwd, agent, env),
      readEnv: () => resolveServerEnv(cwd, undefined, DEPLOY_ENV_FILES),
      assertBuilt: () => {
        builtAgentPath(cwd);
      },
      startTracing,
      cluster: nodeCluster,
      link: processLink,
      listen: listenServer,
      // SIGHUP too: the `--workers` primary reads it as a rolling restart, and a
      // single process stops gracefully on it rather than dying mid-call.
      onSignal: (handler) => {
        for (const signal of signals) process.on(signal, () => handler(signal));
      },
      ignoreSignals: () => {
        for (const signal of signals) process.on(signal, () => undefined);
      },
      sleep,
      exit: (code) => process.exit(code),
      stop: stopProjectServer,
      forever: () => new Promise<never>(() => undefined),
      ui: {
        info: (message) => defaultUi.log.info(message),
        warn: (message) => defaultUi.log.warn(message),
        error: (message) => defaultUi.log.error(message),
        notify: (level, message) => defaultUi.notify(level, message),
      },
    },
  );
}
