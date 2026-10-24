// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start` as a function of its collaborators: serve from one process, or
 * as the `--workers` primary, or as one of its workers. `start.ts` passes the
 * real process, cluster, port and project loaders; the unit tier passes fakes,
 * so every branch is specified without binding a port or forking.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai-runtime";
import { type PrimaryDeps, runPrimary, runWorker } from "./_start-cluster.ts";
import type { PrimaryLink } from "./_start-worker.ts";
import type { ClusterLike } from "./_start-workers.ts";

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
  listen: PrimaryDeps["listen"];
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
  drainTimeoutMs: number;
  maxCallsPerWorker: number;
}

/** How often a draining worker re-checks whether its calls have ended. */
export const DRAIN_POLL_MS = 250;

/**
 * Close the server, flush tracing, exit — on the FIRST signal only.
 *
 * `on` with a latch rather than `once`: a `--workers` worker gets a Ctrl-C
 * twice (from the terminal and from its primary), and a second delivery to a
 * `once` listener would take the default action mid-shutdown. The handler is
 * synchronous: a rejected close becomes a non-zero exit, not an unhandled
 * rejection.
 */
export function stopOnSignal(server: AgentServer, tracing: Tracing, deps: StartRunDeps): void {
  let stopping = false;
  deps.onSignal(() => {
    if (stopping) return;
    stopping = true;
    deps.stop(server, tracing).then(
      () => deps.exit(0),
      (error: unknown) => {
        deps.ui.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        deps.exit(1);
      },
    );
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
  await server.listen(target.port, target.host);
  deps.ui.info(
    `${project.agent.name} listening on http://${target.host ?? "127.0.0.1"}:${server.port}`,
  );
  stopOnSignal(server, tracing, deps);
  return { ok: true, data: { name: project.agent.name, port: server.port, workers: 1 } };
}

/**
 * A `--workers` worker: serve its slot and report to the primary, which owns
 * the public port, the announcement, the command's result AND this worker's
 * lifecycle. So a worker prints no result (`--json` owes ONE line), never
 * settles, and ignores signals — a terminal's Ctrl-C reaches it too, and acting
 * on that would end its calls in the middle of the primary's drain. A failure
 * goes to the primary and ends the process, which the primary reads as a boot
 * failure and reports ONCE as the command's error. Not to stderr as well: every
 * worker fails the same way (a refused workflow agent, a bad bundle), so N
 * workers printed the same paragraph N times before the command's own copy.
 */
async function serveAsWorker(deps: StartRunDeps): Promise<never> {
  deps.ignoreSignals();
  const link = deps.link();
  try {
    const tracing = await deps.startTracing();
    let close: (graceMs: number) => void = () => undefined;
    const { server, activeCalls } = await runWorker(deps.slot(), {
      link,
      load: () => deps.load(),
      build: (agent, env) => deps.build({ agent, env }),
      onDrain: (timeoutMs) => close(timeoutMs),
      onStop: () => close(0),
    });
    close = workerCloser(server, activeCalls, tracing, deps);
    deps.booted?.();
  } catch (error: unknown) {
    // `runWorker` already reported its own failures; this covers what fails
    // before it (tracing). The primary keeps the last report, so twice is harmless.
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
      await deps.stop(server, tracing).then(
        () => deps.exit(0),
        (error: unknown) => {
          deps.ui.error(
            `shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          deps.exit(1);
        },
      );
    })();
  };
}

/**
 * The `--workers` primary (`runPrimary`): it owns no sessions, binds the public
 * port once every worker listens, and never imports the agent — the name comes
 * from the workers.
 */
async function startPrimary(target: StartTarget, deps: StartRunDeps): Promise<StartResult> {
  deps.assertBuilt();
  const env = await deps.readEnv();
  const bound = await runPrimary(
    {
      workers: target.workers,
      port: target.port,
      host: target.host,
      drainTimeoutMs: target.drainTimeoutMs,
      maxCallsPerWorker: target.maxCallsPerWorker,
    },
    {
      cluster: deps.cluster(),
      listen: deps.listen,
      onSignal: deps.onSignal,
      exit: deps.exit,
      log: (message) => deps.ui.notify("warn", message),
    },
  );
  deps.ui.info(
    `${bound.name} listening on http://${target.host ?? "127.0.0.1"}:${bound.port} with ${target.workers} workers`,
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
  return { ok: true, data: { name: bound.name, port: bound.port, workers: target.workers } };
}
