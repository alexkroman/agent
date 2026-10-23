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
 * The primary owns no sessions. It applies the schema once (N workers racing
 * the same `CREATE TABLE IF NOT EXISTS` can collide in the catalog), forks, and
 * respawns a worker that dies — unless it died while BOOTING, which a respawn
 * would only repeat, so that ends the server instead of looping.
 */

import { availableParallelism } from "node:os";

/** Process-env override for the worker count, for a container that cannot pass flags. */
export const WORKERS_ENV = "AAI_WORKERS";

/**
 * Set by the primary in each worker's environment: the schema is applied, so the
 * worker must not race its siblings to apply it again.
 *
 * @internal
 */
export const SCHEMA_READY_ENV = "AAI_START_SCHEMA_READY";

/** A worker that exits sooner than this after forking died booting, not serving. */
export const BOOT_GRACE_MS = 10_000;

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

/** The slice of `node:cluster` the supervisor drives — a seam, so the unit tier forks nothing. */
export interface ClusterLike {
  fork(env?: Record<string, string>): { process: { pid?: number | undefined } };
  on(
    event: "exit",
    listener: (
      worker: { process: { pid?: number | undefined } },
      code: number | null,
      signal: string | null,
    ) => void,
  ): unknown;
}

/** What {@link superviseWorkers} needs besides the cluster. */
export interface SuperviseOptions {
  count: number;
  cluster: ClusterLike;
  /** Log one line; the supervisor never throws for a worker's sake. */
  log: (message: string) => void;
  /** End the primary once no worker can be kept alive. */
  exit: (code: number) => void;
  now?: () => number;
}

/** The running supervisor: {@link SupervisedWorkers.stop} on a signal. */
export interface SupervisedWorkers {
  /** Stop respawning; the primary exits once every worker has. */
  stop(): void;
}

/**
 * Fork `count` workers and keep them alive.
 *
 * A worker that exits within {@link BOOT_GRACE_MS} of its fork failed to boot
 * (a bad build, a port in use, an unreachable database): a respawn would fail
 * the same way, so the primary exits non-zero instead. One that dies later is
 * respawned, so a crash costs that worker's sessions and nothing else.
 */
export function superviseWorkers(opts: SuperviseOptions): SupervisedWorkers {
  const now = opts.now ?? Date.now;
  const bornAt = new Map<number | undefined, number>();
  let live = 0;
  let stopping = false;
  /** Non-zero once a worker failed to boot, so the LAST exit reports the failure. */
  let exitCode = 0;

  const fork = (): void => {
    const worker = opts.cluster.fork({ [SCHEMA_READY_ENV]: "1" });
    bornAt.set(worker.process.pid, now());
    live += 1;
  };

  opts.cluster.on("exit", (worker, code, signal) => {
    live -= 1;
    const pid = worker.process.pid;
    const age = now() - (bornAt.get(pid) ?? 0);
    bornAt.delete(pid);
    if (stopping) {
      if (live === 0) opts.exit(exitCode);
      return;
    }
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (age < BOOT_GRACE_MS) {
      opts.log(`worker ${pid} exited with ${how} while starting; stopping the server`);
      stopping = true;
      exitCode = 1;
      if (live === 0) opts.exit(exitCode);
      return;
    }
    opts.log(`worker ${pid} exited with ${how}; starting a replacement`);
    fork();
  });

  for (let i = 0; i < opts.count; i++) fork();

  return {
    stop() {
      stopping = true;
      if (live === 0) opts.exit(exitCode);
    },
  };
}
