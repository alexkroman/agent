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
 * durable workflow runs (a worker refuses workflows without one — `_start-run.ts`).
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

/**
 * A positive integer from a flag, else its env var, else `fallback` — named on
 * error, with its `unit` when it has one: `--drain-timeout 5m` is the natural
 * thing to type, and "must be a positive integer" alone does not say seconds.
 */
export function resolvePositiveInt(
  flag: string | undefined,
  flagName: string,
  envName: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
  unit?: string,
): number {
  const [raw, source] =
    flag !== undefined ? [flag, flagName] : [env[envName]?.trim() || undefined, envName];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    const what = unit ? `a positive whole number of ${unit}` : "a positive integer";
    throw new Error(`${source} must be ${what} (got ${JSON.stringify(raw)})`);
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

/**
 * How long a worker may take to start listening before it is killed as hung —
 * a boot stuck on a database that never answers (`ensure*Schema` behind the
 * schema lock, a silently partitioned Postgres) would otherwise hold the
 * server at "starting", or a rolling restart open, forever. Generous: an
 * agent's import and its schema DDL are seconds, not minutes.
 */
export const BOOT_TIMEOUT_MS = 120_000;

/** How long a worker told to stop (or done draining) gets before it is SIGKILLed. */
export const STOP_GRACE_MS = 10_000;

/** A pong slower than this is logged (LiveKit's `highPingThreshold`), at most once per {@link SLOW_PONG_LOG_EVERY_MS} per worker. */
export const SLOW_PONG_MS = 500;
export const SLOW_PONG_LOG_EVERY_MS = 30_000;

/** Worker → primary. */
export type WorkerMessage =
  | { type: "aai-start:listening"; name: string; port: number }
  /** `received`: call sockets handed to it so far — the primary's in-transit count is what it sent minus this. */
  | { type: "aai-start:pong"; calls: number; elu: number; received: number }
  | { type: "aai-start:fatal"; message: string }
  | { type: "aai-start:relay"; id: number; target: number; payload: RelayedNotify }
  | { type: "aai-start:relay-cancel"; id: number; target: number }
  | { type: "aai-start:relay-result"; id: number; outcome: RelayOutcome };

/** Primary → worker. */
export type PrimaryMessage =
  /** `call`: the primary's classification (`isCallPath`), so the worker counts it for the drain. */
  | { type: "aai-start:upgrade"; bytes: Uint8Array; call: boolean }
  | { type: "aai-start:ping" }
  | { type: "aai-start:drain"; timeoutMs: number }
  | { type: "aai-start:stop" }
  /** `id` is the PRIMARY's, unique across the server — see `relays` in the supervisor. */
  | { type: "aai-start:relay"; id: number; payload: RelayedNotify }
  | { type: "aai-start:relay-cancel"; id: number }
  | { type: "aai-start:relay-result"; id: number; outcome: RelayOutcome };

/** One of this protocol's messages (every type is `aai-start:`-prefixed) — either direction. */
export function isProtocolMessage<M extends WorkerMessage | PrimaryMessage>(
  message: unknown,
): message is M {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("aai-start:");
}

// ─── The cluster seam ───────────────────────────────────────────────────────

/** One worker process, as the supervisor and router see it. */
export interface WorkerLike {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  /** `false` when the worker is gone and nothing was sent (its socket, if any, is still the caller's). */
  send(message: PrimaryMessage, socket?: Socket): boolean;
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
          if (!worker.isConnected()) return false;
          // `worker.send`'s own boolean is backpressure, not delivery: queued is sent.
          worker.send(message, socket);
          return true;
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
  /** Live calls, as last reported plus admissions since. */
  calls: number;
  /** Event-loop utilization over the last ping interval, 0–1. */
  elu: number;
}

/** Whether a call may go to a slot's worker now — the router's 503 reason when not. */
export type Admission = "ok" | "draining" | "full";

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
  /**
   * Admit a call socket to the slot's current worker, counting it until the
   * worker's next load report (LiveKit's reserved slots) — a reconnect is a new
   * live socket too. The cap covers EVERY call; only the drain lets a reconnect
   * through, so live calls survive a deploy. `resume` is the client's CLAIM to
   * continue a call (`isResume`: any well-formed id), so it never buys past the cap.
   */
  admit(slot: number, resume: boolean): Admission;
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

/** What the supervisor knows about one live worker — forgotten whole when it exits. */
interface Tracked {
  slot: number;
  /** Last reported load; set when it listens, so `undefined` means still starting. */
  load?: { calls: number; elu: number } | undefined;
  /** When it last answered (listening counts); cleared once it is killed for silence. */
  heard?: number | undefined;
  /** When the ping it has yet to answer was sent. */
  pingSentAt?: number | undefined;
  slowLoggedAt?: number | undefined;
  /** Replaced by a rolling restart, and draining its calls. */
  retiring?: boolean | undefined;
  /** SIGKILLed because the server ended while it was still starting — the plan, not a failure. */
  abandoned?: boolean | undefined;
  /** When it was forked; cleared once it listens or is killed for a hung boot. */
  forkedAt?: number | undefined;
  /** Call sockets the router was told it may hand to it, ever — see `onPong`. */
  admitted: number;
}

/** A relayed notice the primary is carrying, under the id IT assigned. */
interface Relay {
  origin: WorkerLike;
  /** The origin's own id, which only that process's pending table knows. */
  originId: number;
  target: WorkerLike;
}

/** Fork one worker per slot and keep each slot served — see the module doc. */
export function superviseWorkers(opts: {
  slots: number;
  cluster: ClusterLike;
  /** Log one line; the supervisor never throws for a worker's sake. */
  log: (message: string) => void;
  /** Calls a worker may hold before `admit` answers `full`. Default unlimited. */
  maxCallsPerWorker?: number | undefined;
  timers?: Partial<Timers>;
}): SupervisedWorkers {
  const { slots, cluster: host, log } = opts;
  const maxCalls = opts.maxCallsPerWorker ?? Number.POSITIVE_INFINITY;
  const { now, every, after } = { ...realTimers(), ...opts.timers };
  const tracked = new Map<WorkerLike, Tracked>();
  /** Slot → its current, listening worker. */
  const ready = new Map<number, ReadyWorker>();
  /** Slot → the replacement a rolling restart is waiting on. */
  const incoming = new Map<number, WorkerLike>();
  /**
   * Relays awaiting a result, keyed by an id the PRIMARY assigns. Keyed by
   * process, never by slot: each worker numbers its relays from 1, and across
   * a crash-respawn or a roll a slot is two processes — a result routed by
   * slot reached the wrong one (an `acked` for a notice it never sent).
   */
  const relays = new Map<number, Relay>();
  let nextRelayId = 0;
  let name: string | undefined;
  let fatal: string | undefined;
  let bootFailure: Error | undefined;
  /** Draining or stopping: no respawns, no new calls, exit once every worker has. */
  let ending = false;
  let forced = false;
  /** The slots a rolling restart has yet to replace, in order. */
  let rollQueue: number[] = [];
  let rollDrainMs = 0;
  let exitCode = 0;
  /** Every slot has listened once; a rolling restart before then is refused. */
  let started = false;
  // Each settles once; a later resolve or reject is a no-op.
  const booted = Promise.withResolvers<{ name: string }>();
  const exited = Promise.withResolvers<number>();
  // `ready` may reject with no one awaiting it (a drain during boot in a spec).
  booted.promise.catch(() => undefined);
  /**
   * Every worker has exited. `ready` rejects only now, so a boot failure never
   * races the shutdown — and it does reject if the server stopped before it
   * was ever ready, rather than leaving the caller waiting forever.
   */
  const settle = (): void => {
    booted.reject(bootFailure ?? new Error("the server stopped before every worker was listening"));
    exited.resolve(exitCode);
  };

  /**
   * How a worker is named in a log line: its slot first, because that is what
   * the `[worker N]` tag on its own lines and `/workers` both key on; the pid
   * is what `kill` and `ps` need.
   */
  const who = (worker: WorkerLike): string =>
    `worker ${tracked.get(worker)?.slot ?? "?"} (pid ${worker.pid})`;
  const fork = (slot: number): WorkerLike => {
    const worker = host.fork({ [SLOT_ENV]: String(slot), [SLOTS_ENV]: String(slots) });
    tracked.set(worker, { slot, forkedAt: now(), admitted: 0 });
    return worker;
  };
  /** Tell `worker` to drain for `drainMs` (or, `undefined`, to stop now); SIGKILL it if still alive past that plus the grace. */
  const retire = (worker: WorkerLike, drainMs: number | undefined): void => {
    worker.send(
      drainMs === undefined
        ? { type: "aai-start:stop" }
        : { type: "aai-start:drain", timeoutMs: drainMs },
    );
    after((drainMs ?? 0) + STOP_GRACE_MS, () => {
      if (tracked.has(worker)) worker.kill("SIGKILL");
    });
  };
  const end = (drainMs: number | undefined): void => {
    ending = true;
    rollQueue = [];
    for (const [worker, state] of tracked) {
      if (state.load) {
        retire(worker, drainMs);
        continue;
      }
      // Still starting: it has not installed its IPC listener yet, so a drain
      // or stop sent now is DROPPED (cluster discards a message nobody
      // listens for) and it would sit out the whole drain timeout before the
      // SIGKILL. It holds no calls — nothing routes to it — so end it now.
      state.abandoned = true;
      worker.kill("SIGKILL");
    }
    if (tracked.size === 0) settle();
  };
  const stop = (): void => {
    if (forced) return;
    forced = true;
    end(undefined);
  };
  /** Start the next slot's replacement, if a rolling restart has one left. */
  const rollNext = (): void => {
    const slot = rollQueue.shift();
    if (slot === undefined) {
      log(
        "rolling restart complete: every slot has a new worker; the old ones finish their " +
          `calls (up to ${Math.round(rollDrainMs / 1000)}s)`,
      );
      return;
    }
    incoming.set(slot, fork(slot));
  };
  const roll = (drainTimeoutMs: number): void => {
    // Said rather than swallowed: an operator who sent SIGHUP is waiting for a
    // roll, and silence reads as one that hung.
    if (ending) {
      log("rolling restart ignored: the server is shutting down");
      return;
    }
    // Before every slot has listened, a replacement could listen ahead of the
    // worker it replaces, which would then take the slot back and orphan it.
    if (!started) {
      log("rolling restart ignored: the server is still starting");
      return;
    }
    if (rollQueue.length > 0 || incoming.size > 0) {
      log("rolling restart ignored: one is already running");
      return;
    }
    rollDrainMs = drainTimeoutMs;
    // A reason left over from an earlier failure must not be blamed on this roll.
    fatal = undefined;
    rollQueue = Array.from({ length: slots }, (_, slot) => slot);
    log(`rolling restart of ${slots} workers`);
    rollNext();
  };
  const answer = (origin: WorkerLike, originId: number, outcome: RelayOutcome): void => {
    if (tracked.has(origin)) {
      origin.send({ type: "aai-start:relay-result", id: originId, outcome });
    }
  };
  const relay = (
    origin: WorkerLike,
    message: Extract<WorkerMessage, { type: "aai-start:relay" }>,
  ) => {
    const target = ready.get(message.target)?.worker;
    if (!target) return answer(origin, message.id, "offline");
    const id = ++nextRelayId;
    relays.set(id, { origin, originId: message.id, target });
    if (!target.send({ type: "aai-start:relay", id, payload: message.payload })) {
      relays.delete(id);
      answer(origin, message.id, "offline");
    }
  };
  const onListening = (worker: WorkerLike, state: Tracked, port: number, agentName: string) => {
    const { slot } = state;
    state.heard = now();
    state.forkedAt = undefined;
    state.load = { calls: 0, elu: 0 };
    const old = ready.get(slot);
    ready.set(slot, { worker, port });
    if (incoming.get(slot) === worker) {
      // A rolling restart's replacement now takes the slot's new traffic; the old worker drains.
      incoming.delete(slot);
      if (old) {
        const oldState = tracked.get(old.worker);
        if (oldState) oldState.retiring = true;
        retire(old.worker, rollDrainMs);
      }
      return rollNext();
    }
    name ??= agentName;
    if (!ending && ready.size === slots) {
      started = true;
      booted.resolve({ name });
    }
  };
  const onPong = (
    worker: WorkerLike,
    state: Tracked,
    pong: Extract<WorkerMessage, { type: "aai-start:pong" }>,
  ) => {
    const at = now();
    const sent = state.pingSentAt;
    state.heard = at;
    // The worker's count misses sockets still crossing the IPC channel; without
    // them, a pong could LOWER the count below what was admitted and let the
    // cap be overshot by every handoff in flight.
    state.load = { calls: pong.calls + Math.max(0, state.admitted - pong.received), elu: pong.elu };
    state.pingSentAt = undefined;
    if (sent === undefined || at - sent <= SLOW_PONG_MS) return;
    // The early warning before the liveness kill, throttled per worker.
    if (at - (state.slowLoggedAt ?? Number.NEGATIVE_INFINITY) < SLOW_PONG_LOG_EVERY_MS) return;
    state.slowLoggedAt = at;
    log(`${who(worker)} answered a ping in ${at - sent}ms; its event loop is lagging`);
  };

  /** The origin stopped waiting, so nothing is owed back to it; tell the target to stop delivering. */
  const cancelRelay = (origin: WorkerLike, originId: number): void => {
    for (const [id, entry] of relays) {
      if (entry.origin !== origin || entry.originId !== originId) continue;
      relays.delete(id);
      entry.target.send({ type: "aai-start:relay-cancel", id });
      return;
    }
  };
  const settleRelay = (from: WorkerLike, id: number, outcome: RelayOutcome): void => {
    const entry = relays.get(id);
    // From the process it was sent to, or it is not this relay's answer.
    if (!entry || entry.target !== from) return;
    relays.delete(id);
    answer(entry.origin, entry.originId, outcome);
  };

  host.onMessage((worker, message) => {
    const state = tracked.get(worker);
    if (state === undefined || !isProtocolMessage<WorkerMessage>(message)) return;
    switch (message.type) {
      case "aai-start:listening":
        return onListening(worker, state, message.port, message.name);
      case "aai-start:fatal":
        fatal = message.message;
        return;
      case "aai-start:pong":
        return onPong(worker, state, message);
      case "aai-start:relay":
        return relay(worker, message);
      case "aai-start:relay-cancel":
        return cancelRelay(worker, message.id);
      case "aai-start:relay-result":
        return settleRelay(worker, message.id, message.outcome);
      default:
        return;
    }
  });

  /**
   * Forget a worker that exited: answer the relays it was delivering (whether
   * or not it was still its slot's current worker — a retired one drains
   * them too) and drop the ones it was waiting on. `true` when it was its
   * slot's current worker.
   */
  const release = (worker: WorkerLike, slot: number): boolean => {
    tracked.delete(worker);
    for (const [id, entry] of relays) {
      if (entry.target === worker) answer(entry.origin, entry.originId, "disconnected");
      if (entry.target === worker || entry.origin === worker) relays.delete(id);
    }
    if (ready.get(slot)?.worker !== worker) return false;
    ready.delete(slot);
    return true;
  };

  /** An exit while draining or stopping: count the verdict, settle with the last. */
  const onEndingExit = (
    worker: WorkerLike,
    slot: number,
    code: number | null,
    signal: string | null,
  ) => {
    const abandoned = tracked.get(worker)?.abandoned === true;
    release(worker, slot);
    // A forced stop's SIGKILL is the plan, not a failure, and so is the one
    // that ends a still-starting worker; anything else non-zero is.
    if (code !== 0 && !((forced || abandoned) && signal === "SIGKILL")) exitCode = 1;
    if (tracked.size === 0) settle();
  };
  /** An exit mid-rollover: a retired worker is simply gone; a failed replacement aborts the roll. */
  const onRollingExit = (worker: WorkerLike, state: Tracked, how: string): boolean => {
    const { slot } = state;
    if (state.retiring) {
      release(worker, slot);
      return true;
    }
    if (incoming.get(slot) !== worker) return false;
    release(worker, slot);
    incoming.delete(slot);
    rollQueue = [];
    // The worker's own reason (a broken build, a bad env) is what the operator
    // must fix before the next SIGHUP; the exit code alone does not say it.
    const why = fatal === undefined ? "" : `: ${fatal}`;
    log(
      `rolling restart stopped: the replacement for slot ${slot} exited with ${how} while starting${why}`,
    );
    return true;
  };

  /**
   * Any other exit. Before listening it is a boot failure, which a respawn
   * would only repeat, so the server stops; after, the slot gets a replacement.
   */
  const onCrash = (worker: WorkerLike, state: Tracked, how: string) => {
    const label = who(worker);
    if (!release(worker, state.slot)) {
      log(`${label} exited with ${how} while starting; stopping the server`);
      bootFailure = new Error(fatal ?? `a worker exited with ${how} before it was listening`);
      exitCode = 1;
      stop();
      return;
    }
    // How many calls the crash cost is the first thing an operator reading this needs.
    const held = state.load?.calls ?? 0;
    const cost = held === 0 ? "" : ` (it held ${held} live call${held === 1 ? "" : "s"})`;
    log(`${label} exited with ${how}; starting a replacement${cost}`);
    fork(state.slot);
  };

  host.onExit((worker, code, signal) => {
    const state = tracked.get(worker);
    if (state === undefined) return;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (ending) return onEndingExit(worker, state.slot, code, signal);
    if (!onRollingExit(worker, state, how)) onCrash(worker, state, how);
  });

  // Liveness: a worker answers pings from its event loop, so silence means the
  // loop is wedged and every call on it is already dead. Kill it; the exit
  // handler respawns it into its slot like any other crash.
  const stopPinging = every(PING_INTERVAL_MS, () => {
    const at = now();
    for (const [worker, state] of tracked) {
      if (state.forkedAt !== undefined && at - state.forkedAt >= BOOT_TIMEOUT_MS) {
        const why = `did not start listening within ${BOOT_TIMEOUT_MS / 1000}s`;
        log(`${who(worker)} ${why}; stopping it`);
        // Its exit is then a boot failure (or a failed roll) that names why.
        fatal = `a worker ${why}`;
        state.forkedAt = undefined;
        worker.kill("SIGKILL");
        continue;
      }
      if (state.heard === undefined) continue;
      const silentFor = at - state.heard;
      if (silentFor >= LIVENESS_TIMEOUT_MS) {
        log(`${who(worker)} has not answered for ${Math.round(silentFor / 1000)}s; restarting it`);
        state.heard = undefined;
        worker.kill("SIGKILL");
        continue;
      }
      // One ping outstanding at a time, so a pong's latency is measured from
      // the ping it answers rather than a later one.
      state.pingSentAt ??= at;
      worker.send({ type: "aai-start:ping" });
    }
  });
  void exited.promise.then(stopPinging);

  for (let slot = 0; slot < slots; slot++) fork(slot);
  return {
    ready: booted.promise,
    exited: exited.promise,
    target: (slot) => ready.get(slot),
    accepting: () => !ending,
    admit: (slot, resume) => {
      if (ending && !resume) return "draining";
      const current = ready.get(slot);
      const state = current && tracked.get(current.worker);
      const load = state?.load;
      if (!(state && load)) return "ok";
      if (load.calls >= maxCalls) return "full";
      load.calls += 1;
      state.admitted += 1;
      return "ok";
    },
    status: () =>
      [...tracked].map(([worker, state]) => {
        let phase: WorkerStatus["state"] = state.load ? "serving" : "starting";
        if (ending || state.retiring) phase = "draining";
        return {
          slot: state.slot,
          pid: worker.pid,
          state: phase,
          calls: state.load?.calls ?? 0,
          elu: state.load?.elu ?? 0,
        };
      }),
    drain: (timeoutMs) => {
      if (!ending) end(timeoutMs);
    },
    stop,
    roll,
  };
}
