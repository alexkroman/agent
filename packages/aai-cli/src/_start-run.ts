// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start` as a function of its collaborators: serve from one process, or
 * as the `--workers` primary, or as one of its workers. `start.ts` passes the
 * real process, cluster, port and project loaders; the unit tier passes fakes,
 * so every branch is specified without binding a port or forking.
 *
 * @module
 */

import type http from "node:http";
import type { AgentDef } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import { createRouter } from "./_start-router.ts";
import {
  joinCluster,
  type PrimaryLink,
  type WorkerRuntime,
  workflowsNeedDatabase,
} from "./_start-worker.ts";
import { type ClusterLike, type SupervisedWorkers, superviseWorkers } from "./_start-workers.ts";

/** What the start command answers, for `--json` and for tests. */
export interface StartResult {
  ok: true;
  data: { name: string; port: number | undefined; workers: number };
}

type Project = { agent: AgentDef; env: Record<string, string> };
type Tracing = { shutdown(): Promise<void> } | undefined;

/** Everything `aai start` touches outside its own logic. */
export interface StartRunDeps {
  /** Is this process a `--workers` worker? */
  isWorker: boolean;
  /** A worker's slot and the slot count (read from its environment). */
  slot(): { slot: number; slots: number };
  load(): Promise<Project>;
  build(project: Project): Promise<AgentServer>;
  /** A worker is listening: its boot is over (the runtime's boot lines are slot 0's alone). */
  booted?(): void;
  /** The project's env without importing the agent — the primary's read. */
  readEnv(): Promise<Record<string, string>>;
  /** Throw (saying what to run) when there is no build. */
  assertBuilt(): void;
  startTracing(): Promise<Tracing>;
  cluster(): ClusterLike;
  link(): PrimaryLink;
  /** A worker's runtime seams; the real ones unless a spec says otherwise. */
  runtime?: WorkerRuntime;
  /** Bind the primary's router; resolves with the bound port, rejects when the bind fails. */
  listen(server: http.Server, port: number, host: string | undefined): Promise<number>;
  /** Run `handler` on each SIGINT/SIGTERM/SIGHUP. */
  onSignal(handler: (signal: NodeJS.Signals) => void): void;
  exit(code: number): void;
  stop(server: AgentServer, tracing: Tracing): Promise<void>;
  /** Never settles: a worker serves until its primary ends it. */
  forever(): Promise<never>;
  /** Make SIGINT/SIGTERM do nothing here — a worker's primary owns its lifecycle. */
  ignoreSignals(): void;
  sleep(ms: number): Promise<void>;
  ui: {
    info(message: string): void;
    error(message: string): void;
    notify(level: "warn" | "error", message: string): void;
  };
}

/** The address to bind, and how `--workers` places and retires calls. */
export interface StartTarget {
  port: number;
  host: string | undefined;
  workers: number;
  /** How long a drain lets calls finish before the worker is closed anyway. */
  drainTimeoutMs: number;
  /** Calls a worker may hold before NEW ones are refused with 503. */
  maxCallsPerWorker: number;
}

/** How often a draining worker re-checks whether its calls have ended. */
export const DRAIN_POLL_MS = 250;

/** A taken port, said in the operator's terms rather than as a raw `EADDRINUSE`. */
export function bindError(error: unknown, port: number): unknown {
  if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) return error;
  return new Error(`port ${port} is in use; pass --port or set PORT`, { cause: error });
}

/** Close the server and flush tracing, then exit: 0, or 1 with the failure reported. */
function shutdown(server: AgentServer, tracing: Tracing, deps: StartRunDeps): Promise<void> {
  return deps.stop(server, tracing).then(
    () => deps.exit(0),
    (error: unknown) => {
      deps.ui.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      deps.exit(1);
    },
  );
}

/**
 * Shut down on the FIRST signal only.
 *
 * `on` with a latch rather than `once`: a second delivery to a `once` listener
 * would take the default action mid-shutdown. The handler is synchronous: a
 * rejected close becomes a non-zero exit, not an unhandled rejection.
 */
export function stopOnSignal(server: AgentServer, tracing: Tracing, deps: StartRunDeps): void {
  let stopping = false;
  deps.onSignal(() => {
    if (stopping) return;
    stopping = true;
    void shutdown(server, tracing, deps);
  });
}

/** Serve the built agent: one process, the `--workers` primary, or a worker. */
export async function runStart(target: StartTarget, deps: StartRunDeps): Promise<StartResult> {
  if (deps.isWorker) return serveAsWorker(deps);
  if (target.workers > 1) return startPrimary(target, deps);
  // Before the server, so the first model call a request causes is already
  // reported (`@alexkroman1/aai-runtime/tracing`; undefined with no collector).
  const tracing = await deps.startTracing();
  const project = await deps.load();
  const server = await deps.build(project);
  await server.listen(target.port, target.host).catch((error: unknown) => {
    throw bindError(error, target.port);
  });
  deps.ui.info(
    `${project.agent.name} listening on http://${target.host ?? "127.0.0.1"}:${server.port}`,
  );
  stopOnSignal(server, tracing, deps);
  return { ok: true, data: { name: project.agent.name, port: server.port, workers: 1 } };
}

/**
 * A `--workers` worker: refuse an agent with workflows and no database (a run
 * must be readable from every worker), build, and join the primary — which owns
 * the public port, the announcement, the command's result AND this worker's
 * lifecycle. So a worker prints no result (`--json` owes ONE line), never
 * settles, and ignores signals: a terminal's Ctrl-C reaches it too, and acting
 * on that would end its calls in the middle of the primary's drain.
 *
 * A failure is told to the primary (WHY, so its error names the cause rather
 * than "a worker exited") and ends the process; the primary reports it ONCE as
 * the command's error. Not to stderr as well: every worker fails the same way,
 * so N workers printed the same paragraph N times before the command's copy.
 */
async function serveAsWorker(deps: StartRunDeps): Promise<never> {
  deps.ignoreSignals();
  const link = deps.link();
  const { slot, slots } = deps.slot();
  try {
    const tracing = await deps.startTracing();
    const { agent, env } = await deps.load();
    if (!env.DATABASE_URL && Object.keys(agent.workflows ?? {}).length > 0) {
      throw new Error(workflowsNeedDatabase(slots));
    }
    const server = await deps.build({ agent, env });
    let close: (graceMs: number) => void = () => undefined;
    const { activeCalls } = await joinCluster({
      slot,
      slots,
      server,
      name: agent.name,
      link,
      runtime: deps.runtime,
      close: (graceMs) => close(graceMs),
    });
    close = workerCloser(server, activeCalls, tracing, deps);
    deps.booted?.();
  } catch (error: unknown) {
    link.send({
      type: "aai-start:fatal",
      message: error instanceof Error ? error.message : String(error),
    });
    deps.exit(1);
  }
  return deps.forever();
}

/**
 * How a worker ends: wait (up to `graceMs`) for its calls to finish, then close
 * the server and exit. A drain passes its timeout; a stop passes 0 — and a stop
 * arriving mid-drain cuts the wait short. Closing happens once.
 */
export function workerCloser(
  server: AgentServer,
  activeCalls: () => number,
  tracing: Tracing,
  deps: StartRunDeps,
): (graceMs: number) => void {
  let deadline: number | undefined;
  let waited = 0;
  return (graceMs) => {
    const first = deadline === undefined;
    deadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, graceMs);
    if (!first) return;
    void (async () => {
      while (activeCalls() > 0 && waited < (deadline ?? 0)) {
        await deps.sleep(DRAIN_POLL_MS);
        waited += DRAIN_POLL_MS;
      }
      await shutdown(server, tracing, deps);
    })();
  };
}

/**
 * The `--workers` primary: it owns no sessions and never imports the agent (the
 * name comes from the workers). It binds the public port FIRST — so a taken
 * port fails before anything is forked — and routes nothing until every slot
 * listens: until then each request gets 503 and `/health` says it is starting.
 * Workers ignore signals, so this is where they are interpreted:
 *
 * - the first SIGINT/SIGTERM DRAINS: new calls are refused (503), everything
 *   else — a reconnect, an `/api` call, a run read — still routes, `/health`
 *   answers 503 so a load balancer stops sending calls, and each worker exits
 *   once its calls end or `drainTimeoutMs` passes;
 * - a second one STOPS: every worker closes now;
 * - SIGHUP is a ROLLING RESTART: each slot's worker is replaced by a fresh one
 *   that takes the slot's new traffic, while the old one drains its calls.
 *
 * Rejects, with every worker stopped, when a worker fails to boot.
 */
async function startPrimary(target: StartTarget, deps: StartRunDeps): Promise<StartResult> {
  deps.assertBuilt();
  const env = await deps.readEnv();
  // Assigned right after the bind; `serving` once every slot has listened.
  let supervisor: SupervisedWorkers | undefined;
  let serving = false;
  const router = createRouter({
    slots: target.workers,
    target: (slot) => (serving ? supervisor?.target(slot) : undefined),
    admitCall: (slot, resume) => supervisor?.admit(slot, resume) ?? "draining",
    notReady: () => {
      if (!serving) return "server is starting";
      return supervisor?.accepting() ? undefined : "server is draining";
    },
    status: () => supervisor?.status() ?? [],
  });
  const port = await deps.listen(router, target.port, target.host).catch((error: unknown) => {
    throw bindError(error, target.port);
  });
  const workers = superviseWorkers({
    slots: target.workers,
    cluster: deps.cluster(),
    log: (message) => deps.ui.notify("warn", message),
    maxCallsPerWorker: target.maxCallsPerWorker,
  });
  supervisor = workers;
  let signals = 0;
  deps.onSignal((signal) => {
    if (signal === "SIGHUP") return workers.roll(target.drainTimeoutMs);
    signals += 1;
    if (signals > 1) return workers.stop();
    deps.ui.notify(
      "warn",
      `draining: new calls are refused; live calls get up to ${target.drainTimeoutMs / 1000}s ` +
        "(signal again to stop now)",
    );
    workers.drain(target.drainTimeoutMs);
  });
  const { name } = await workers.ready.catch((error: unknown) => {
    router.close();
    throw error;
  });
  serving = true;
  void workers.exited.then((code) => {
    // The last line of a drain: without it the process just vanishes, and an
    // operator watching a deploy cannot tell a finished drain from a crash.
    deps.ui.notify(
      "warn",
      code === 0 ? "every worker has exited; stopping" : "stopping (a worker exited with an error)",
    );
    router.close();
    deps.exit(code);
  });
  deps.ui.info(
    `${name} listening on http://${target.host ?? "127.0.0.1"}:${port} with ${target.workers} workers`,
  );
  // After the workers boot, not before: a worker can still REFUSE to run
  // without a database (an agent with workflows), and a warning that reconnects
  // will resume fine, printed just ahead of that refusal, contradicted it.
  // `notify`, so a container (JSON mode, no TTY) still sees it.
  if (!env.DATABASE_URL) {
    deps.ui.notify(
      "warn",
      `No DATABASE_URL: each of the ${target.workers} workers keeps its own calls in memory. ` +
        "Every client is routed to the same worker each time, so reconnects resume — " +
        "but a call does not survive its worker crashing. Set DATABASE_URL for that.",
    );
  }
  return { ok: true, data: { name, port, workers: target.workers } };
}

/** Bind `server` the way the primary does; the real {@link StartRunDeps.listen}. */
export function listenServer(
  server: http.Server,
  port: number,
  host: string | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host ?? "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
