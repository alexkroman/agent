// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start --workers` — serve one built agent from several processes.
 *
 * A single `aai start` process runs every session on one JavaScript thread, so
 * it tops out at one core no matter how many the machine has. Measured with
 * the real provider adapters against a local fake, one process held ~1000
 * concurrent browser sessions with flat latency and fell over by ~1500 while
 * the rest of the machine idled; four processes held ≥3000. The ceiling is the
 * event loop, so the fix is more event loops.
 *
 * ## Why `node:cluster`
 *
 * A socket cannot be handed to a `worker_thread`, and a per-frame hop to one
 * would cost more than the work it moved. Whole SESSIONS are the unit worth
 * moving, and `node:cluster` is the one primitive that shares a listening port
 * across processes: the primary accepts and deals connections round-robin, and
 * each worker runs the ordinary `aai start` server with its own event loop.
 *
 * ## Why more than one worker needs `DATABASE_URL`
 *
 * Round-robin has no affinity. Without a database every worker keeps its own
 * session state and its own local workflow world, so a browser reconnecting
 * with `?sessionId=` reaches a worker that never heard of the session, and a
 * run started on one worker cannot be read from another. That is the
 * multi-replica rule `createProjectServer` already warns about — except a
 * replica behind a load balancer can be made sticky, and these cannot. So it is
 * refused rather than warned: with Postgres every worker shares the state, and
 * resume and run `notify` work across them.
 *
 * What stays per-worker even then: anything that reaches a LIVE session through
 * this process's memory — an `/api` route's `ctx.speech`, and `/inbox`
 * sockets — reaches only sessions held by the worker that took the request.
 *
 * ## Supervision
 *
 * The primary owns no sessions and never imports the agent. It applies the
 * schema once (N workers racing the same `CREATE TABLE IF NOT EXISTS` can
 * collide in the catalog), forks, and waits for every worker to report that it
 * is LISTENING — which is what "booted" means, rather than a timer, and what
 * gives the primary the bound port and the agent's name to announce. A worker
 * that dies after reporting is respawned. One that dies before reporting failed
 * to boot, which a respawn would only repeat, so the primary stops every worker
 * and fails the command instead of looping.
 */

import { availableParallelism } from "node:os";

/** Process-env override for the worker count, for a container that cannot pass flags. */
export const WORKERS_ENV = "AAI_WORKERS";

/** What a worker sends its primary once it is serving. */
export interface ListeningMessage {
  type: "aai-start:listening";
  name: string;
  port: number | undefined;
}

function isListening(message: unknown): message is ListeningMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "aai-start:listening"
  );
}

/** Tell the primary this worker is serving. A no-op outside a cluster worker. */
export function announceListening(name: string, port: number | undefined): void {
  process.send?.({ type: "aai-start:listening", name, port } satisfies ListeningMessage);
}

/**
 * Parse a worker count: a positive integer, or `auto` for one per available CPU.
 *
 * @throws when the value is neither — named, so the CLI error says which input.
 */
export function parseWorkers(
  value: string,
  source: string,
  cpus: () => number = availableParallelism,
): number {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "auto") return Math.max(1, cpus());
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new Error(
      `${source} must be a positive integer or "auto" (got ${JSON.stringify(value)})`,
    );
  }
  return Number(trimmed);
}

/** The worker count: the flag, then {@link WORKERS_ENV}, then 1. */
export function resolveWorkers(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cpus: () => number = availableParallelism,
): number {
  if (flag !== undefined) return parseWorkers(flag, "--workers", cpus);
  const fromEnv = env[WORKERS_ENV]?.trim();
  if (fromEnv) return parseWorkers(fromEnv, WORKERS_ENV, cpus);
  return 1;
}

/** Refuse a multi-worker server whose state would be split across processes. */
export function assertWorkersSupported(workers: number, databaseUrl: string | undefined): void {
  if (workers <= 1 || databaseUrl) return;
  throw new Error(
    `--workers ${workers} needs DATABASE_URL. Without it each worker keeps its own session ` +
      "state and workflow runs, and connections are dealt round-robin, so a reconnect or a run " +
      "lookup lands on a process that never saw it. Set DATABASE_URL (any Postgres), or run one worker.",
  );
}

/** One worker, as the supervisor sees it. */
export interface WorkerLike {
  process: { pid?: number | undefined };
  kill(signal?: string): void;
}

/** The slice of `node:cluster` the supervisor drives — a seam, so the unit tier forks nothing. */
export interface ClusterLike {
  fork(): WorkerLike;
  on(
    event: "exit",
    listener: (worker: WorkerLike, code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: "message", listener: (worker: WorkerLike, message: unknown) => void): unknown;
}

/** The running supervisor. */
export interface SupervisedWorkers {
  /**
   * Every worker is listening: the agent's name and the bound port, from the
   * first to report. REJECTS — once every worker has exited — when one died
   * before it was listening.
   */
  ready: Promise<{ name: string; port: number | undefined }>;
  /** Every worker has exited after a stop: 0, or 1 if any exited non-zero. */
  exited: Promise<number>;
  /** Stop respawning and pass `signal` to every worker. Idempotent. */
  stop(signal?: string): void;
}

/** Fork `count` workers and keep them alive — see the module doc for the policy. */
export function superviseWorkers(opts: {
  count: number;
  cluster: ClusterLike;
  /** Log one line; the supervisor never throws for a worker's sake. */
  log: (message: string) => void;
}): SupervisedWorkers {
  /** Live workers, and whether each has reported that it is listening. */
  const workers = new Map<WorkerLike, boolean>();
  let first: ListeningMessage | undefined;
  let bootFailure: Error | undefined;
  let stopping = false;
  let exitCode = 0;
  let readyDone = false;
  let resolveReady!: (value: { name: string; port: number | undefined }) => void;
  let rejectReady!: (error: Error) => void;
  let resolveExited!: (code: number) => void;
  const ready = new Promise<{ name: string; port: number | undefined }>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const exited = new Promise<number>((res) => {
    resolveExited = res;
  });

  const fork = (): void => {
    workers.set(opts.cluster.fork(), false);
  };
  const stop = (signal = "SIGTERM"): void => {
    stopping = true;
    for (const worker of workers.keys()) worker.kill(signal);
    if (workers.size === 0) settle();
  };
  const settle = (): void => {
    if (bootFailure && !readyDone) {
      readyDone = true;
      rejectReady(bootFailure);
    }
    resolveExited(exitCode);
  };

  opts.cluster.on("message", (worker, message) => {
    if (!(isListening(message) && workers.has(worker))) return;
    workers.set(worker, true);
    first ??= message;
    if (!(readyDone || stopping) && [...workers.values()].every(Boolean)) {
      readyDone = true;
      resolveReady({ name: first.name, port: first.port });
    }
  });

  opts.cluster.on("exit", (worker, code, signal) => {
    const listening = workers.get(worker);
    workers.delete(worker);
    const pid = worker.process.pid;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (stopping) {
      if (code !== 0) exitCode = 1;
      if (workers.size === 0) settle();
      return;
    }
    if (!listening) {
      opts.log(`worker ${pid} exited with ${how} while starting; stopping the server`);
      bootFailure = new Error(`a worker exited with ${how} before it was listening`);
      exitCode = 1;
      stop();
      return;
    }
    opts.log(`worker ${pid} exited with ${how}; starting a replacement`);
    fork();
  });

  for (let i = 0; i < opts.count; i++) fork();
  return { ready, exited, stop };
}
