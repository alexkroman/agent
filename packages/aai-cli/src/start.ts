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

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "@alexkroman1/aai";
import {
  type AgentServer,
  createAgentServer,
  ensureSessionStateSchema,
  ensureWorkflowJournalSchema,
  withHostCredentialFallback,
} from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { DEPLOY_ENV_FILES, resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";
import { WORKER_ARTIFACT_REL } from "./build.ts";

/** Where `aai build` leaves the built browser client, relative to the root. */
export const CLIENT_ARTIFACT_REL = path.join(".aai", "client");

/** The port `aai start` binds when neither an argument nor `PORT` says otherwise. */
export const DEFAULT_START_PORT = 3000;

/** Options for {@link createProjectServer} and {@link executeStart}. */
export interface StartOptions {
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
}

/**
 * Load the built agent, or fail saying what to run.
 *
 * A `file:` URL rather than a relative specifier, because on Windows a bare
 * POSIX-looking path is not a valid module specifier.
 */
export async function loadBuiltAgent(cwd: string): Promise<AgentDef> {
  const workerPath = path.join(cwd, WORKER_ARTIFACT_REL);
  if (!existsSync(workerPath)) {
    throw new Error(
      `No built agent at ${WORKER_ARTIFACT_REL}. ` +
        "Run `aai build` first — the scaffold's `prestart` script normally does it for you.",
    );
  }
  const worker = (await import(pathToFileURL(workerPath).href)) as { default: AgentDef };
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
    log.warn("client.tsx is not built — serving the default UI. Run `aai build` first.");
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
 * // api/index.mjs, emitted by `aai build --target vercel` — `no-check` because
 * // this file lives in the USER's project, where `@alexkroman1/aai-cli/start`
 * // resolves; it cannot resolve from inside this package.
 * import { createProjectServer } from "@alexkroman1/aai-cli/start";
 *
 * export default (await createProjectServer({ cwd: process.cwd() })).node;
 * ```
 */
export async function createProjectServer(options: StartOptions): Promise<AgentServer> {
  const { cwd } = options;
  const agent = await loadBuiltAgent(cwd);
  // `.env.example` counts as a declaration here — see `DEPLOY_ENV_FILES`, which
  // is what lets a container ship no `.env` and supply the values as real
  // environment variables.
  const env = await resolveServerEnv(cwd, undefined, DEPLOY_ENV_FILES);

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
  } else {
    // Say that this process is the only place the state lives, because the next
    // thing an operator does with a container is run two of them. It is not
    // only about restarts: the browser reconnects with `?sessionId=`, so a
    // reconnect landing on another replica resumes a session that replica has
    // never heard of, and the agent's context is gone mid-call.
    log.warn(
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
  });
}

/** What {@link executeStart} answers, for `--json` and for tests. */
export interface StartResult {
  ok: true;
  data: { name: string; port: number | undefined };
}

/**
 * Serve the built agent and keep serving it: bind, announce, and shut down
 * cleanly on a signal.
 *
 * The signal listeners are SYNCHRONOUS. An `async` one hands its promise to
 * `process`, which discards what a listener returns — so a `close()` that
 * rejected would surface as an unhandled rejection, i.e. a crash with a stack
 * trace on Ctrl-C, instead of the non-zero exit a failed shutdown should be.
 */
export async function executeStart(options: StartOptions): Promise<StartResult> {
  const agent = await loadBuiltAgent(options.cwd);
  const server = await createProjectServer(options);
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_START_PORT);
  const host = options.host ?? (process.env.HOST?.trim() || undefined);

  await server.listen(port, host);
  log.info(`${agent.name} listening on http://${host ?? "127.0.0.1"}:${server.port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // close() shuts the runtime down too — no separate runtime.shutdown().
      server.close().then(
        () => process.exit(0),
        (error: unknown) => {
          log.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        },
      );
    });
  }

  return { ok: true, data: { name: agent.name, port: server.port } };
}
