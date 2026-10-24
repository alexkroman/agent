// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start --workers` — serve one built agent from several processes.
 *
 * A single `aai start` process runs every session on one JavaScript thread, so
 * it tops out at one core no matter how many the machine has. Measured with
 * the real provider adapters against a local fake, one process held ~1000
 * concurrent browser sessions with flat latency and fell over by ~1500 while
 * the rest of the machine idled. The ceiling is the event loop, so the fix is
 * more event loops — one per worker, each owning a SLOT.
 *
 * ## The shape
 *
 * The primary owns the public port and routes every request by affinity
 * (`_start-affinity.ts`, `_start-router.ts`): a WebSocket upgrade is handed to
 * its worker as a raw socket, so audio never passes through the primary again;
 * plain HTTP is proxied per request to the worker's private loopback port.
 * A worker never binds the public port. Because a client's session, inbox and
 * route calls all reach its own worker, nothing about a live call has to be
 * shared — so more than one worker does NOT need a database. A `DATABASE_URL`
 * adds what memory cannot: a session that survives its worker crashing, and
 * durable workflow runs (`_start-worker.ts` refuses workflows without one).
 *
 * The one cross-worker path is an `/inbox` notice from a workflow step, which
 * runs wherever the engine runs it: the step's worker forwards it here and this
 * supervisor hands it to the worker owning the client (`inbox/relay.ts` in the
 * runtime).
 *
 * ## Supervision
 *
 * The primary owns no sessions and never imports the agent. A worker reports
 * LISTENING over IPC — that report, not a timer, is what "booted" means. A
 * worker that dies after reporting is respawned into the SAME slot, so every
 * key keeps routing where it did. One that dies before reporting failed to
 * boot, which a respawn would only repeat, so the primary stops every worker
 * and fails the command instead of looping.
 */

import cluster, { type Worker } from "node:cluster";
import type { Socket } from "node:net";
import { availableParallelism } from "node:os";
import type { ClientNotifier } from "@alexkroman1/aai/host-internal";

/** Process-env override for the worker count, for a container that cannot pass flags. */
export const WORKERS_ENV = "AAI_WORKERS";

/** The env a worker learns its place from. Read only under `cluster.isWorker`. */
export const SLOT_ENV = "AAI_START_SLOT";
export const SLOTS_ENV = "AAI_START_SLOTS";

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

// ─── The IPC protocol between a worker and its primary ──────────────────────

/** An inbox notice in transit: everything `notifyClientHere` takes but the signal. */
export interface RelayedNotify {
  op: "notify";
  clientId: string;
  notice: Parameters<ClientNotifier>[1];
  ackTimeoutMs: number;
}

/** The outcome of a relayed notice — the inbox's own vocabulary. */
export type RelayOutcome = Awaited<ReturnType<ClientNotifier>>;

/** How often the primary pings each listening worker. */
export const PING_INTERVAL_MS = 2500;

/**
 * A worker that has not answered a ping for this long has a wedged event loop:
 * it is killed and respawned into its slot. Long, because a kill costs every
 * call the worker holds — this is for a loop that will never come back, not a
 * slow one (LiveKit's supervisor uses the same 60 s).
 */
export const LIVENESS_TIMEOUT_MS = 60_000;

/** Worker → primary. */
export type WorkerMessage =
  | { type: "aai-start:listening"; name: string; port: number }
  | { type: "aai-start:pong" }
  | { type: "aai-start:fatal"; message: string }
  | { type: "aai-start:relay"; id: number; target: number; payload: RelayedNotify }
  | { type: "aai-start:relay-cancel"; id: number; target: number }
  | { type: "aai-start:relay-result"; id: number; origin: number; outcome: RelayOutcome };

/** Primary → worker. */
export type PrimaryMessage =
  | { type: "aai-start:upgrade"; bytes: Uint8Array }
  | { type: "aai-start:ping" }
  | { type: "aai-start:relay"; id: number; origin: number; payload: RelayedNotify }
  | { type: "aai-start:relay-cancel"; id: number; origin: number }
  | { type: "aai-start:relay-result"; id: number; outcome: RelayOutcome };

function isWorkerMessage(message: unknown): message is WorkerMessage {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("aai-start:");
}

// ─── The cluster seam ───────────────────────────────────────────────────────

/** One worker process, as the supervisor and router see it. */
export interface WorkerLike {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  send(message: PrimaryMessage, socket?: Socket): void;
}

/** The slice of `node:cluster` the supervisor drives — a seam, so the unit tier forks nothing. */
export interface ClusterLike {
  fork(env: Record<string, string>): WorkerLike;
  onExit(listener: (worker: WorkerLike, code: number | null, signal: string | null) => void): void;
  onMessage(listener: (worker: WorkerLike, message: unknown) => void): void;
}

/**
 * `node:cluster` behind {@link ClusterLike}. Structured-clone IPC, because a
 * relayed notice can carry audio (`Uint8Array`), which JSON would mangle.
 */
export function nodeCluster(): ClusterLike {
  cluster.setupPrimary({ serialization: "advanced" });
  const wrapped = new Map<Worker, WorkerLike>();
  const like = (worker: Worker): WorkerLike => {
    let handle = wrapped.get(worker);
    if (!handle) {
      handle = {
        pid: worker.process.pid,
        kill: (signal) => worker.process.kill(signal),
        send: (message, socket) => {
          if (worker.isConnected()) worker.send(message, socket);
        },
      };
      wrapped.set(worker, handle);
    }
    return handle;
  };
  return {
    fork: (env) => like(cluster.fork(env)),
    onExit: (listener) =>
      cluster.on("exit", (worker, code, signal) => {
        listener(like(worker), code, signal);
        wrapped.delete(worker);
      }),
    onMessage: (listener) =>
      cluster.on("message", (worker, message) => listener(like(worker), message)),
  };
}

// ─── The supervisor ─────────────────────────────────────────────────────────

/** A slot whose worker has reported listening. */
export interface ReadyWorker {
  worker: WorkerLike;
  /** Its private loopback port, the target for proxied HTTP. */
  port: number;
}

/** The running supervisor. */
export interface SupervisedWorkers {
  /**
   * Every slot is listening: the agent's name, from the first to report.
   * REJECTS — once every worker has exited — when one failed to boot.
   */
  ready: Promise<{ name: string }>;
  /** Every worker has exited after a stop: 0, or 1 if any exited non-zero. */
  exited: Promise<number>;
  /** The listening worker in `slot`, or `undefined` while it is (re)starting. */
  target(slot: number): ReadyWorker | undefined;
  /** Stop respawning and pass `signal` to every worker. Idempotent. */
  stop(signal?: NodeJS.Signals): void;
}

/** Fork one worker per slot and keep each slot served — see the module doc. */
export function superviseWorkers(opts: {
  slots: number;
  cluster: ClusterLike;
  /** Log one line; the supervisor never throws for a worker's sake. */
  log: (message: string) => void;
  /** Clock and timer seams for the liveness check — real ones unless a spec says otherwise. */
  now?: () => number;
  every?: (ms: number, tick: () => void) => () => void;
}): SupervisedWorkers {
  const { slots, cluster: host, log } = opts;
  const now = opts.now ?? Date.now;
  const every =
    opts.every ??
    ((ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      // The primary exits when its workers do; a ping must not hold it open.
      timer.unref();
      return () => clearInterval(timer);
    });
  /** When each listening worker last answered (or reported listening). */
  const lastHeard = new Map<WorkerLike, number>();
  /** Live worker → its slot. */
  const slotOf = new Map<WorkerLike, number>();
  /** Slot → its listening worker. */
  const ready = new Map<number, ReadyWorker>();
  /** Relays awaiting a result, per TARGET slot, so a dying target can answer them. */
  const inflight = new Map<number, Map<string, { id: number; origin: number }>>();
  let name: string | undefined;
  let bootFailure: Error | undefined;
  let fatal: string | undefined;
  let stopping = false;
  let exitCode = 0;
  let readyDone = false;
  let resolveReady!: (value: { name: string }) => void;
  let rejectReady!: (error: Error) => void;
  let resolveExited!: (code: number) => void;
  const readyPromise = new Promise<{ name: string }>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const exited = new Promise<number>((res) => {
    resolveExited = res;
  });

  const fork = (slot: number): void => {
    slotOf.set(host.fork({ [SLOT_ENV]: String(slot), [SLOTS_ENV]: String(slots) }), slot);
  };
  const settle = (): void => {
    if (bootFailure && !readyDone) {
      readyDone = true;
      rejectReady(bootFailure);
    }
    resolveExited(exitCode);
  };
  const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
    stopping = true;
    stopPinging();
    for (const worker of slotOf.keys()) worker.kill(signal);
    if (slotOf.size === 0) settle();
  };
  const answerOrigin = (origin: number, id: number, outcome: RelayOutcome): void => {
    ready.get(origin)?.worker.send({ type: "aai-start:relay-result", id, outcome });
  };
  const relay = (origin: number, message: Extract<WorkerMessage, { type: "aai-start:relay" }>) => {
    const target = ready.get(message.target);
    if (!target) return answerOrigin(origin, message.id, "offline");
    let pending = inflight.get(message.target);
    if (!pending) {
      pending = new Map();
      inflight.set(message.target, pending);
    }
    pending.set(`${origin}:${message.id}`, { id: message.id, origin });
    target.worker.send({
      type: "aai-start:relay",
      id: message.id,
      origin,
      payload: message.payload,
    });
  };

  host.onMessage((worker, message) => {
    const slot = slotOf.get(worker);
    if (slot === undefined || !isWorkerMessage(message)) return;
    switch (message.type) {
      case "aai-start:listening":
        ready.set(slot, { worker, port: message.port });
        lastHeard.set(worker, now());
        name ??= message.name;
        if (!(readyDone || stopping) && ready.size === slots) {
          readyDone = true;
          resolveReady({ name });
        }
        return;
      case "aai-start:fatal":
        fatal = message.message;
        return;
      case "aai-start:pong":
        lastHeard.set(worker, now());
        return;
      case "aai-start:relay":
        return relay(slot, message);
      case "aai-start:relay-cancel":
        ready
          .get(message.target)
          ?.worker.send({ type: "aai-start:relay-cancel", id: message.id, origin: slot });
        return;
      case "aai-start:relay-result":
        inflight.get(slot)?.delete(`${message.origin}:${message.id}`);
        answerOrigin(message.origin, message.id, message.outcome);
        return;
      default:
        return;
    }
  });

  /** Drop a worker that exited from its slot, answering what it can no longer answer. */
  const release = (worker: WorkerLike, slot: number): boolean => {
    slotOf.delete(worker);
    lastHeard.delete(worker);
    const wasListening = ready.get(slot)?.worker === worker;
    if (wasListening) ready.delete(slot);
    // A notice in flight to this worker will never be answered by it.
    for (const { id, origin } of inflight.get(slot)?.values() ?? []) {
      answerOrigin(origin, id, "disconnected");
    }
    inflight.delete(slot);
    return wasListening;
  };

  host.onExit((worker, code, signal) => {
    const slot = slotOf.get(worker);
    if (slot === undefined) return;
    const wasListening = release(worker, slot);
    if (stopping) {
      if (code !== 0) exitCode = 1;
      if (slotOf.size === 0) settle();
      return;
    }
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (!wasListening) {
      log(`worker ${worker.pid} exited with ${how} while starting; stopping the server`);
      bootFailure = new Error(fatal ?? `a worker exited with ${how} before it was listening`);
      exitCode = 1;
      stop();
      return;
    }
    log(`worker ${worker.pid} (slot ${slot}) exited with ${how}; starting a replacement`);
    fork(slot);
  });

  // Liveness: a worker answers pings from its event loop, so silence means the
  // loop is wedged and every call on it is already dead. Kill it; the exit
  // handler respawns it into its slot like any other crash.
  const stopPinging = every(PING_INTERVAL_MS, () => {
    const at = now();
    for (const { worker } of ready.values()) {
      const silentFor = at - (lastHeard.get(worker) ?? at);
      if (silentFor >= LIVENESS_TIMEOUT_MS) {
        log(
          `worker ${worker.pid} has not answered for ${Math.round(silentFor / 1000)}s; restarting it`,
        );
        lastHeard.delete(worker);
        worker.kill("SIGKILL");
        continue;
      }
      worker.send({ type: "aai-start:ping" });
    }
  });

  for (let slot = 0; slot < slots; slot++) fork(slot);
  return { ready: readyPromise, exited, target: (slot) => ready.get(slot), stop };
}
