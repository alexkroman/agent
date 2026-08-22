// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 template: `aai-runtime:workflow`. The host side of durable
 * workflows, as a starter written at epoch 1 — copy this file into your host,
 * swap the marked edit points, and delete the routes you do not serve.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so
 * `pnpm typecheck` is the backward-compatibility gate and an error here IS the
 * finding. Do not edit it to make an error go away: an API that has to change
 * gets a NEW epoch carrying a new template, never a change to this one. The
 * imports are relative source paths because nothing ships this file.
 *
 * Front to back: a {@link RunStore} you point at your own World, the
 * nine-method {@link WdkAdapter} written against it, the options bag a host
 * assembles before any workflow route can serve, and the request-contract
 * guards a route applies at the edge.
 *
 * What to change:
 *
 * - {@link memoryRunStore} — the placeholder store. Everything else is written
 *   against {@link RunStore}, so repointing this at your World is the only
 *   structural edit.
 * - {@link PUBLIC_URL} — your deployment's externally reachable origin. A
 *   webhook callback URL is built from this and nothing else, which is why it
 *   is passed in rather than read out of the environment.
 * - {@link mintRunId} — hand out ids from your store instead, if it mints them.
 *
 * What not to change: the guards below are the request contract, and a host
 * that restates the numbers instead of importing them drifts from the server
 * that enforces them.
 */

import {
  createMemoryKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  type Logger,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_INPUT_BYTES,
  type WdkAdapter,
  type WdkRunRecord,
  type WdkStreamOptions,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowClientOptions,
} from "../../../runtime-barrel.ts";

/** Your deployment's public origin. ← change this */
export const PUBLIC_URL = "https://agents.example.com/daily-digest";

/** The channel a run's progress is written to when a reader names none. */
const DEFAULT_CHANNEL = "progress";

/** One run as your store holds it. */
export type StoredRun = {
  record: WdkRunRecord;
  /** Whatever `start` was handed. A world journals it and re-reads it on replay. */
  input: unknown;
  /** Set once the run completes; `readOutput` refuses to answer before then. */
  output: unknown;
  /**
   * Chunks a step's `report()` wrote, keyed by channel, oldest first. Written
   * by the world running the steps — never by the adapter — so in the
   * placeholder store below nothing writes it and a progress read is empty.
   */
  channels: Readonly<Record<string, readonly unknown[]>>;
};

/**
 * What the adapter needs from a World. ← implement this against yours
 *
 * Nothing here throws for an absent run: each operation answers with the
 * "nothing there" value instead, because the adapter above it must too.
 */
export type RunStore = {
  create(record: WdkRunRecord, input: unknown): Promise<void>;
  read(runId: string): Promise<StoredRun | undefined>;
  list(workflowName: string, limit: number): Promise<WdkRunRecord[]>;
  /** `false` when there was nothing to cancel — no such run, or already terminal. */
  markCancelled(runId: string): Promise<boolean>;
  /** Re-schedule a sleeping run; the count of hooks actually woken. */
  wake(runId: string, correlationIds: string[] | undefined): Promise<number>;
  /** Deliver to whatever hook holds `token`; `false` when none does. */
  deliverSignal(token: string, payload: unknown): Promise<boolean>;
  readChannel(runId: string, channel: string): Promise<readonly unknown[]>;
};

/** Where run ids come from. ← change this if your store mints them */
export function mintRunId(): string {
  return `run_${crypto.randomUUID()}`;
}

/**
 * The stream half of the adapter.
 *
 * Synchronous in the interface, and the read inside must stay LAZY: the run
 * lookup and the encryption-key resolution happen when a chunk is first
 * pulled, which is what keeps an unread stream from costing anything.
 * `startIndex` is where a reconnecting reader resumes.
 */
function channelStream(
  store: RunStore,
  runId: string,
  options: WdkStreamOptions,
): ReadableStream<unknown> {
  const channel = options.namespace ?? DEFAULT_CHANNEL;
  const from = Math.max(0, options.startIndex ?? 0);
  return new ReadableStream<unknown>({
    async pull(controller) {
      const chunks = await store.readChannel(runId, channel);
      for (const chunk of chunks.slice(from)) controller.enqueue({ channel, chunk });
      controller.close();
    },
  });
}

/**
 * The adapter. Nine methods, no partial-implementation affordance — so this is
 * the skeleton: keep every method, and delegate each to your own store.
 *
 * Note what each one ANSWERS rather than throws: `cancel` resolves `false` for
 * a run that was already terminal, `signal` resolves `false` when no hook holds
 * the token, `wakeUp` resolves `0` for a run that is gone, and `getRun`
 * resolves `undefined`. A route turns each of those into a status code, and an
 * exception would turn "there is no such run" into a 500.
 */
export function hostWdkAdapter(store: RunStore): WdkAdapter {
  return {
    start: async (workflowId: string, args: unknown[]) => {
      const runId = mintRunId();
      await store.create(
        {
          runId,
          // The COMPILER's identifier for the workflow, not the key your agent
          // declares it under. `listRuns` filters on this same string, and
          // filtering by the declared name matches nothing at all.
          workflowName: workflowId,
          status: "pending",
          createdAt: Date.now(),
        },
        args[0],
      );
      return runId;
    },
    getRun: async (runId: string) => (await store.read(runId))?.record,
    listRuns: (workflowId: string, limit: number) => store.list(workflowId, limit),
    cancel: (runId: string) => store.markCancelled(runId),
    wakeUp: (runId: string, correlationIds: string[] | undefined) =>
      store.wake(runId, correlationIds),
    signal: (token: string, payload: unknown) => store.deliverSignal(token, payload),
    readStream: (runId: string, options: WdkStreamOptions) => channelStream(store, runId, options),
    // `-1` for a channel nothing has written to. This is what makes a progress
    // read TERMINATE: a stream reports `done` only once CLOSED, and a channel
    // one step writes after another never is, so the tail is the bound.
    streamTail: async (runId: string, options: WdkStreamOptions) =>
      (await store.readChannel(runId, options.namespace ?? DEFAULT_CHANNEL)).length - 1,
    readOutput: async (runId: string) => {
      const run = await store.read(runId);
      return run?.record.status === "completed" ? run.output : undefined;
    },
  };
}

/**
 * The placeholder store. ← replace this with your World
 *
 * Good enough for a dev mode or a spec and nothing else: it forgets everything
 * on restart, and it runs no steps, so `readChannel` and `deliverSignal` have
 * nothing to answer with.
 */
export function memoryRunStore(): RunStore {
  const runs = new Map<string, StoredRun>();
  return {
    create: async (record: WdkRunRecord, input: unknown) => {
      runs.set(record.runId, { record, input, output: undefined, channels: {} });
    },
    read: async (runId: string) => runs.get(runId),
    list: async (workflowName: string, limit: number) =>
      [...runs.values()]
        .map((run) => run.record)
        .filter((record) => record.workflowName === workflowName)
        .reverse()
        .slice(0, limit),
    markCancelled: async (runId: string) => {
      const run = runs.get(runId);
      if (run === undefined) return false;
      if (run.record.status !== "pending" && run.record.status !== "running") return false;
      runs.set(runId, { ...run, record: { ...run.record, status: "cancelled" } });
      return true;
    },
    wake: async (runId: string) => (runs.has(runId) ? 1 : 0),
    deliverSignal: async () => false,
    readChannel: async (runId: string, channel: string) => runs.get(runId)?.channels[channel] ?? [],
  };
}

/**
 * The bag a host assembles before any workflow route can serve.
 *
 * `workflows` is the record your bundled agent declares — pass it through
 * rather than restating it here, or a run started over HTTP resolves to a
 * different definition than the one the agent runs. `keys` is the
 * correlation-key index: memory under a dev server, Postgres on a deployment,
 * and the choice belongs to whoever knows which world this process is in.
 */
export function hostWorkflowOptions(
  workflows: WorkflowClientOptions["workflows"],
  logger: Logger,
): WorkflowClientOptions {
  return {
    workflows,
    keys: createMemoryKeyStore(), // ← your key store
    wdk: hostWdkAdapter(memoryRunStore()), // ← your World
    publicUrl: PUBLIC_URL,
    logger,
  };
}

/** The facts a route is admitted or refused on. */
export type WorkflowRequest = {
  path: string;
  authorization: string | undefined;
  /** The raw body of a start request; absent on reads. */
  body?: string | undefined;
};

/**
 * The token gate.
 *
 * The API is OPEN by default and deliberately so — a static page carries no
 * credential, exactly like the voice client beside it — so an operator who
 * wants a bearer required sets this one variable in the agent's env and every
 * route starts demanding it. Compare with a constant-time equality if your
 * platform offers one.
 */
export function unauthorized(
  authorization: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const required = env[WORKFLOW_API_TOKEN_ENV];
  if (required === undefined || required === "") return undefined;
  return authorization === `Bearer ${required}` ? undefined : "missing or wrong bearer token";
}

/**
 * Refuse an oversized run input before it reaches a run record.
 *
 * Measured in BYTES rather than `String.length`: the cap is a byte budget, and
 * a body of multi-byte characters otherwise passes at up to ~3x its nominal
 * size. Keep the cap — the input is journaled and re-read on every replay, so
 * anything large belongs behind a URL or an upload id.
 */
export function inputTooLarge(body: string): string | undefined {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes <= MAX_WORKFLOW_INPUT_BYTES) return undefined;
  return `run input is ${bytes} bytes; the limit is ${MAX_WORKFLOW_INPUT_BYTES}`;
}

/** Clamp what a caller asked for into what one lookup is allowed to scan. */
export function findLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WORKFLOW_FIND_LIMIT;
  return Math.max(1, Math.min(Math.floor(requested), MAX_WORKFLOW_FIND_LIMIT));
}

/**
 * The edge, in the order a host applies it: is this ours, may the caller in,
 * is the payload within contract. Returns the refusal, or `undefined` to serve.
 */
export function admitWorkflowRequest(
  req: WorkflowRequest,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!req.path.startsWith(WORKFLOW_API_PREFIX)) return "not a workflow route";
  const refused = unauthorized(req.authorization, env);
  if (refused !== undefined) return refused;
  return req.body === undefined ? undefined : inputTooLarge(req.body);
}

/** One line about a run, for a status route or a CLI listing. */
export function describeRun(record: WdkRunRecord | undefined): string {
  if (record === undefined) return "no such run";
  // `createdAt` is a Date from one world and a number from another, so a reader
  // normalizes rather than assuming either.
  const startedAt =
    typeof record.createdAt === "number" ? record.createdAt : record.createdAt.getTime();
  const why = record.error === undefined ? "" : `: ${record.error.message}`;
  return `${record.workflowName} ${record.status} (started ${new Date(startedAt).toISOString()})${why}`;
}
