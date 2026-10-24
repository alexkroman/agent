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

/** Env overrides for the drain timeout (seconds) and the per-worker call cap. */
export const DRAIN_TIMEOUT_ENV = "AAI_DRAIN_TIMEOUT";
export const MAX_CALLS_ENV = "AAI_MAX_CALLS_PER_WORKER";

/** How long a drain lets calls finish by default: most calls end well inside it. */
export const DEFAULT_DRAIN_TIMEOUT_S = 300;

/** A positive integer from a flag, else its env var, else `fallback` — named on error. */
export function resolvePositiveInt(
  flag: string | undefined,
  flagName: string,
  envName: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const [raw, source] =
    flag !== undefined ? [flag, flagName] : [env[envName]?.trim() || undefined, envName];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error(`${source} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
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
 * it is killed and respawned into its slot.
 *
 * Shorter than LiveKit's 60 s on purpose. Theirs guards ONE call per process;
 * a worker here holds hundreds, and a loop blocked for this long has already
 * stopped every one of them — their audio stalled at the first missed frame —
 * so waiting longer only lengthens the outage before the respawn.
 */
export const LIVENESS_TIMEOUT_MS = 15_000;

/** How long a worker told to stop (or done draining) gets before it is SIGKILLed. */
export const STOP_GRACE_MS = 10_000;

/** A pong slower than this is logged (LiveKit's `highPingThreshold`), at most once per {@link SLOW_PONG_LOG_EVERY_MS} per worker. */
export const SLOW_PONG_MS = 500;
export const SLOW_PONG_LOG_EVERY_MS = 30_000;

/** Worker → primary. */
export type WorkerMessage =
  | { type: "aai-start:listening"; name: string; port: number }
  | { type: "aai-start:pong"; calls: number; elu: number }
  | { type: "aai-start:fatal"; message: string }
  | { type: "aai-start:relay"; id: number; target: number; payload: RelayedNotify }
  | { type: "aai-start:relay-cancel"; id: number; target: number }
  | { type: "aai-start:relay-result"; id: number; origin: number; outcome: RelayOutcome };

/** Primary → worker. */
export type PrimaryMessage =
  | { type: "aai-start:upgrade"; bytes: Uint8Array }
  | { type: "aai-start:ping" }
  | { type: "aai-start:drain"; timeoutMs: number }
  | { type: "aai-start:stop" }
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

/** A slot's current worker: where its new traffic goes. */
export interface ReadyWorker {
  worker: WorkerLike;
  /** Its private loopback port, the target for proxied HTTP. */
  port: number;
}

/** One worker as `/workers` reports it. */
export interface WorkerStatus {
  slot: number;
  pid: number | undefined;
  state: "starting" | "serving" | "draining";
  /** Live calls, as last reported plus handoffs since. */
  calls: number;
  /** Event-loop utilization over the last ping interval, 0–1. */
  elu: number;
}

/** The running supervisor. */
export interface SupervisedWorkers {
  /**
   * Every slot is listening: the agent's name, from the first to report.
   * REJECTS — once every worker has exited — when one failed to boot.
   */
  ready: Promise<{ name: string }>;
  /** Every worker has exited after a drain or stop: 0, or 1 if any exited non-zero. */
  exited: Promise<number>;
  /** The slot's current worker, or `undefined` while it is (re)starting. */
  target(slot: number): ReadyWorker | undefined;
  /** Whether new calls are being placed at all (`false` once draining or stopping). */
  accepting(): boolean;
  /** Live calls on the slot's current worker, counting handoffs not yet reported. */
  calls(slot: number): number;
  /** Count a call handed to the slot's current worker before its next report. */
  reserve(slot: number): void;
  /** Every live worker, for `/workers`. */
  status(): WorkerStatus[];
  /** Stop placing calls; each worker finishes its calls (up to `timeoutMs`) and exits. */
  drain(timeoutMs: number): void;
  /** Stop now: every worker closes at once; SIGKILL after {@link STOP_GRACE_MS}. Idempotent. */
  stop(): void;
  /**
   * Replace every worker one slot at a time without dropping a call: start the
   * replacement, move the slot's new traffic to it once it listens, and drain
   * the old one. Ignored while one is already running or the server is stopping.
   */
  roll(drainTimeoutMs: number): void;
}

/** Timer seams — real ones unless a spec says otherwise. */
interface Timers {
  now: () => number;
  every: (ms: number, tick: () => void) => () => void;
  after: (ms: number, fire: () => void) => void;
}

function realTimers(): Timers {
  // Unref'd: the primary exits when its workers do, and no timer of the
  // supervisor's may hold it open past that.
  return {
    now: Date.now,
    every: (ms, tick) => {
      const timer = setInterval(tick, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
    after: (ms, fire) => {
      setTimeout(fire, ms).unref();
    },
  };
}

/** Fork one worker per slot and keep each slot served — see the module doc. */
export function superviseWorkers(opts: {
  slots: number;
  cluster: ClusterLike;
  /** Log one line; the supervisor never throws for a worker's sake. */
  log: (message: string) => void;
  timers?: Partial<Timers>;
}): SupervisedWorkers {
  const { slots, cluster: host, log } = opts;
  const { now, every, after } = { ...realTimers(), ...opts.timers };
  /** Live worker → its slot. */
  const slotOf = new Map<WorkerLike, number>();
  /** Slot → its current, listening worker. */
  const ready = new Map<number, ReadyWorker>();
  /** Workers being replaced by a rolling restart, draining their calls. */
  const retiring = new Set<WorkerLike>();
  /** Slot → the replacement a rolling restart is waiting on. */
  const incoming = new Map<number, WorkerLike>();
  /** Last reported load, per worker that has listened. */
  const loadOf = new Map<WorkerLike, { calls: number; elu: number }>();
  /** When each listening worker last answered, its outstanding ping, and its last slow-pong log. */
  const lastHeard = new Map<WorkerLike, number>();
  const pingSentAt = new Map<WorkerLike, number>();
  const slowLoggedAt = new Map<WorkerLike, number>();
  /** Relays awaiting a result, per TARGET slot, so a dying target can answer them. */
  const inflight = new Map<number, Map<string, { id: number; origin: number }>>();
  let name: string | undefined;
  let bootFailure: Error | undefined;
  let fatal: string | undefined;
  /** Draining or stopping: no respawns, no new calls, exit once every worker has. */
  let ending = false;
  let forced = false;
  /** The slots a rolling restart has yet to replace, in order. */
  let rollQueue: number[] = [];
  let rollDrainMs = 0;
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

  const fork = (slot: number): WorkerLike => {
    const worker = host.fork({ [SLOT_ENV]: String(slot), [SLOTS_ENV]: String(slots) });
    slotOf.set(worker, slot);
    return worker;
  };
  const settle = (): void => {
    if (bootFailure && !readyDone) {
      readyDone = true;
      rejectReady(bootFailure);
    }
    resolveExited(exitCode);
  };
  /** SIGKILL `worker` after `ms` if it is still alive then. */
  const killAfter = (worker: WorkerLike, ms: number): void => {
    after(ms, () => {
      if (slotOf.has(worker)) worker.kill("SIGKILL");
    });
  };
  const stop = (): void => {
    if (forced) return;
    ending = true;
    forced = true;
    rollQueue = [];
    for (const worker of slotOf.keys()) {
      worker.send({ type: "aai-start:stop" });
      killAfter(worker, STOP_GRACE_MS);
    }
    if (slotOf.size === 0) settle();
  };
  const drain = (timeoutMs: number): void => {
    if (ending) return;
    ending = true;
    rollQueue = [];
    for (const worker of slotOf.keys()) {
      worker.send({ type: "aai-start:drain", timeoutMs });
      killAfter(worker, timeoutMs + STOP_GRACE_MS);
    }
    if (slotOf.size === 0) settle();
  };
  /** Start the next slot's replacement, if a rolling restart has one left. */
  const rollNext = (): void => {
    const slot = rollQueue.shift();
    if (slot === undefined) {
      log("rolling restart complete");
      return;
    }
    incoming.set(slot, fork(slot));
  };
  const roll = (drainTimeoutMs: number): void => {
    if (ending || rollQueue.length > 0 || incoming.size > 0) return;
    rollDrainMs = drainTimeoutMs;
    rollQueue = Array.from({ length: slots }, (_, slot) => slot);
    log(`rolling restart of ${slots} workers`);
    rollNext();
  };
  /** A replacement is listening: move its slot's new traffic to it and drain the old worker. */
  const swapIn = (worker: WorkerLike, slot: number, port: number): void => {
    incoming.delete(slot);
    const old = ready.get(slot);
    ready.set(slot, { worker, port });
    if (old) {
      retiring.add(old.worker);
      old.worker.send({ type: "aai-start:drain", timeoutMs: rollDrainMs });
      killAfter(old.worker, rollDrainMs + STOP_GRACE_MS);
    }
    rollNext();
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
  /** Say a worker's loop is lagging — the early warning before the liveness kill. */
  const warnSlow = (worker: WorkerLike, slot: number, ms: number, at: number): void => {
    if (at - (slowLoggedAt.get(worker) ?? Number.NEGATIVE_INFINITY) < SLOW_PONG_LOG_EVERY_MS) {
      return;
    }
    slowLoggedAt.set(worker, at);
    log(
      `worker ${worker.pid} (slot ${slot}) answered a ping in ${ms}ms; its event loop is lagging`,
    );
  };
  const onListening = (worker: WorkerLike, slot: number, port: number, agentName: string) => {
    lastHeard.set(worker, now());
    loadOf.set(worker, { calls: 0, elu: 0 });
    if (incoming.get(slot) === worker) return swapIn(worker, slot, port);
    ready.set(slot, { worker, port });
    name ??= agentName;
    if (!(readyDone || ending) && ready.size === slots) {
      readyDone = true;
      resolveReady({ name });
    }
  };
  const onPong = (worker: WorkerLike, slot: number, calls: number, elu: number) => {
    const at = now();
    lastHeard.set(worker, at);
    loadOf.set(worker, { calls, elu });
    const sent = pingSentAt.get(worker);
    pingSentAt.delete(worker);
    if (sent !== undefined && at - sent > SLOW_PONG_MS) warnSlow(worker, slot, at - sent, at);
  };

  host.onMessage((worker, message) => {
    const slot = slotOf.get(worker);
    if (slot === undefined || !isWorkerMessage(message)) return;
    switch (message.type) {
      case "aai-start:listening":
        return onListening(worker, slot, message.port, message.name);
      case "aai-start:fatal":
        fatal = message.message;
        return;
      case "aai-start:pong":
        return onPong(worker, slot, message.calls, message.elu);
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

  /** Drop a worker that exited from every table; answer what it can no longer answer. */
  const release = (worker: WorkerLike, slot: number): boolean => {
    slotOf.delete(worker);
    retiring.delete(worker);
    loadOf.delete(worker);
    lastHeard.delete(worker);
    pingSentAt.delete(worker);
    slowLoggedAt.delete(worker);
    const wasCurrent = ready.get(slot)?.worker === worker;
    if (wasCurrent) {
      ready.delete(slot);
      // A notice in flight to this worker will never be answered by it.
      for (const { id, origin } of inflight.get(slot)?.values() ?? []) {
        answerOrigin(origin, id, "disconnected");
      }
      inflight.delete(slot);
    }
    return wasCurrent;
  };

  /** A worker exited mid-rollover: a retired one is simply gone; a failed replacement aborts the roll. */
  const onRollingExit = (worker: WorkerLike, slot: number, how: string): boolean => {
    if (retiring.has(worker)) {
      release(worker, slot);
      return true;
    }
    if (incoming.get(slot) === worker) {
      release(worker, slot);
      incoming.delete(slot);
      rollQueue = [];
      log(
        `rolling restart stopped: the replacement for slot ${slot} exited with ${how} while starting`,
      );
      return true;
    }
    return false;
  };

  /** A worker exited while the server drains or stops: count the verdict, settle with the last. */
  const onEndingExit = (
    worker: WorkerLike,
    slot: number,
    code: number | null,
    signal: string | null,
  ) => {
    release(worker, slot);
    // A forced stop's SIGKILL is the plan, not a failure; anything else non-zero is.
    if (code !== 0 && !(forced && signal === "SIGKILL")) exitCode = 1;
    if (slotOf.size === 0) settle();
  };

  host.onExit((worker, code, signal) => {
    const slot = slotOf.get(worker);
    if (slot === undefined) return;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (ending) return onEndingExit(worker, slot, code, signal);
    if (onRollingExit(worker, slot, how)) return;
    const wasCurrent = release(worker, slot);
    if (!wasCurrent) {
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
    for (const [worker, heard] of lastHeard) {
      const silentFor = at - heard;
      if (silentFor >= LIVENESS_TIMEOUT_MS) {
        log(
          `worker ${worker.pid} has not answered for ${Math.round(silentFor / 1000)}s; restarting it`,
        );
        lastHeard.delete(worker);
        worker.kill("SIGKILL");
        continue;
      }
      // One ping outstanding at a time, so a pong's latency is measured from
      // the ping it answers rather than a later one.
      if (!pingSentAt.has(worker)) pingSentAt.set(worker, at);
      worker.send({ type: "aai-start:ping" });
    }
  });
  void exited.then(stopPinging);

  for (let slot = 0; slot < slots; slot++) fork(slot);
  return {
    ready: readyPromise,
    exited,
    target: (slot) => ready.get(slot),
    accepting: () => !ending,
    calls: (slot) => {
      const current = ready.get(slot);
      return current ? (loadOf.get(current.worker)?.calls ?? 0) : 0;
    },
    reserve: (slot) => {
      const current = ready.get(slot);
      const load = current && loadOf.get(current.worker);
      if (load) load.calls += 1;
    },
    status: () =>
      [...slotOf].map(([worker, slot]) => {
        const load = loadOf.get(worker);
        let state: WorkerStatus["state"] = load === undefined ? "starting" : "serving";
        if (ending || retiring.has(worker)) state = "draining";
        return {
          slot,
          pid: worker.pid,
          state,
          calls: load?.calls ?? 0,
          elu: load?.elu ?? 0,
        };
      }),
    drain,
    stop,
    roll,
  };
}
