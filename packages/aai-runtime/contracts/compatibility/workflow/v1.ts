// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:workflow` epoch 1.
 *
 * What "frozen" obliges is one thing only: this file must keep COMPILING
 * against current source for as long as epoch 1 is advertised as retained, so
 * `pnpm typecheck` — not a claim in a changelog — is the backward-compatibility
 * gate. An error here IS the finding; editing the example to make it go away
 * defeats the whole mechanism. The imports are relative source paths because
 * nothing ships this file and the package's own npm name does not resolve from
 * inside it.
 *
 * This is the HOST side of durable workflows — what `aai dev`, the guest
 * sandbox and a self-hosted `server.mjs` do, and what an agent author never
 * touches (an `agent.ts` declares a `workflow()` and starts it from a tool;
 * none of the names below appear in it). Three things make up the whole of it:
 *
 * - **{@link WdkAdapter} is a SEAM, and this example implements one.** The
 *   Workflow DevKit's own `start` resolves a World from the environment at call
 *   time, so a client specified against it needs a real Postgres or a
 *   `.workflow-data/` directory to answer even the simplest question. Injecting
 *   the nine entry points instead is what lets a host stand the client up
 *   against a store it controls — a spec, an in-memory dev mode, a replay
 *   harness. Production passes `wdkAdapter()`; this passes its own.
 * - **{@link WorkflowClientOptions} is assembled by the embedder**, because
 *   every field in it is a deployment decision the SDK must not sniff: which
 *   world the keys live in, which adapter, and above all `publicUrl` — the only
 *   thing a webhook callback URL can be built from, passed in rather than read
 *   from an environment variable so the SDK never depends on the vocabulary of
 *   one of its three deployments.
 * - **The limits are the request contract**, and a host restates none of them:
 *   `DEFAULT_/MAX_WORKFLOW_FIND_LIMIT` bound what one lookup may scan,
 *   {@link MAX_WORKFLOW_INPUT_BYTES} bounds a run input (small on purpose — the
 *   input is journaled and re-read on every replay, so bytes belong behind a
 *   URL or an upload id), and {@link WORKFLOW_API_TOKEN_ENV} is how an operator
 *   CLOSES an API that is open by default.
 *
 * The `"use workflow"` directive below is inert — nothing compiles this through
 * the DevKit's builder — which is the point: what is frozen is the way a host
 * WRITES against these names.
 */

import { workflow } from "@alexkroman1/aai";
import { z } from "zod";
import {
  createMemoryKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  type Logger,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_INPUT_BYTES,
  type WdkAdapter,
  type WdkRunRecord,
  type WdkStreamOptions,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowClientOptions,
} from "../../../runtime-barrel.ts";

/** The channel a run's progress is written to when a reader names none. */
const DEFAULT_CHANNEL = "progress";

/** One declared workflow, the shape `agent({ workflows })` holds. */
const digest = workflow({
  description: "Summarize everything published on a topic today.",
  input: z.object({ topic: z.string() }),
  run: async ({ topic }: { topic: string }) => {
    "use workflow";

    return { headline: `today in ${topic}` };
  },
});

/** What the stub adapter below keeps per run. */
type StubRun = {
  record: WdkRunRecord;
  /** Whatever `start` was handed, kept because a real world journals it. */
  input: unknown;
  /** The run's progress channel: chunks a `report()` from a step wrote. */
  chunks: unknown[];
};

/**
 * The stream half of the adapter.
 *
 * Synchronous — in the DevKit and here — because the underlying read is LAZY:
 * it defers the run lookup and the encryption-key resolution until a chunk is
 * actually pulled, which is what keeps an unread stream from costing anything.
 * `startIndex` is where a reconnecting reader resumes.
 */
function replayChunks(
  run: StubRun | undefined,
  options: WdkStreamOptions,
): ReadableStream<unknown> {
  const from = Math.max(0, options.startIndex ?? 0);
  const channel = options.namespace ?? DEFAULT_CHANNEL;
  const chunks = run === undefined ? [] : run.chunks.slice(from);
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue({ channel, chunk });
      controller.close();
    },
  });
}

/**
 * A {@link WdkAdapter} over a store the host owns.
 *
 * Note what each method ANSWERS rather than throws: `cancel` resolves `false`
 * for a run that was already terminal, `signal` resolves `false` when no hook
 * holds the token, `wakeUp` resolves `0` for a run that is gone, and `getRun`
 * resolves `undefined` rather than raising. A caller of the workflow HTTP API
 * turns each of those into a status code, and an exception would turn "there is
 * no such run" into a 500.
 */
export function stubAdapter(runs: Map<string, StubRun>): WdkAdapter {
  let minted = 0;
  return {
    start: async (workflowId: string, args: unknown[]) => {
      const runId = `run_${++minted}`;
      runs.set(runId, {
        record: {
          runId,
          // The COMPILER's identifier, not the key the agent declares the
          // workflow under — `listRuns` filters on this same string, and
          // filtering it by the declared name matches nothing at all.
          workflowName: workflowId,
          status: "pending",
          createdAt: Date.now(),
        },
        input: args[0],
        chunks: [],
      });
      return runId;
    },
    getRun: async (runId: string) => runs.get(runId)?.record,
    listRuns: async (workflowId: string, limit: number) =>
      [...runs.values()]
        .map((run) => run.record)
        .filter((record) => record.workflowName === workflowId)
        .reverse()
        .slice(0, limit),
    cancel: async (runId: string) => {
      const run = runs.get(runId);
      if (run === undefined) return false;
      if (run.record.status !== "pending" && run.record.status !== "running") return false;
      runs.set(runId, { ...run, record: { ...run.record, status: "cancelled" } });
      return true;
    },
    wakeUp: async (runId: string, correlationIds: string[] | undefined) => {
      const run = runs.get(runId);
      if (run === undefined) return 0;
      return correlationIds === undefined ? 1 : correlationIds.length;
    },
    signal: async (_token: string, _payload: unknown) => false,
    readStream: (runId: string, options: WdkStreamOptions) =>
      replayChunks(runs.get(runId), options),
    // `-1` for a channel nothing has written to. This is what makes a progress
    // read TERMINATE: a stream reports `done` only once CLOSED, and a channel
    // written by one step after another never is, so the tail is the bound.
    streamTail: async (runId: string, _options: WdkStreamOptions) =>
      (runs.get(runId)?.chunks.length ?? 0) - 1,
    readOutput: async (runId: string) => {
      const run = runs.get(runId);
      return run?.record.status === "completed" ? run.input : undefined;
    },
  };
}

/**
 * The bag a host assembles before `ctx.workflows` exists.
 *
 * `keys` is the correlation-key index — a memory store under `aai dev`, a
 * Postgres one on a deployment, and the choice belongs to whoever knows which
 * world this process is in.
 */
export function clientOptions(wdk: WdkAdapter, logger: Logger): WorkflowClientOptions {
  return {
    workflows: { digest },
    keys: createMemoryKeyStore(),
    wdk,
    publicUrl: "https://agents.example.com/daily-digest",
    logger,
  };
}

/** Clamp what a caller asked for into what one lookup is allowed to scan. */
export function findLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WORKFLOW_FIND_LIMIT;
  return Math.max(1, Math.min(Math.floor(requested), MAX_WORKFLOW_FIND_LIMIT));
}

/**
 * Refuse an oversized run input at the edge, before it enters a run record.
 *
 * Measured in BYTES rather than `String.length`: the cap is a byte budget, and
 * a body of multi-byte characters otherwise passes at up to ~3x its nominal
 * size.
 */
export function inputTooLarge(body: string): string | undefined {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes <= MAX_WORKFLOW_INPUT_BYTES) return undefined;
  return `run input is ${bytes} bytes; the limit is ${MAX_WORKFLOW_INPUT_BYTES}`;
}

/**
 * Closing the workflow API.
 *
 * It is OPEN by default and deliberately so — a static page carries no
 * credential, exactly like the voice client beside it — so an operator who
 * wants a bearer required sets this one variable in the agent's env, and every
 * route starts demanding it.
 */
export function withApiToken(env: Record<string, string>, token: string): Record<string, string> {
  return { ...env, [WORKFLOW_API_TOKEN_ENV]: token };
}

/** One line about a run, for a status tool or a CLI listing. */
export function describeRun(record: WdkRunRecord | undefined): string {
  if (record === undefined) return "no such run";
  // `createdAt` is a Date from one world and a number from another, so a reader
  // normalizes rather than assuming either.
  const startedAt =
    typeof record.createdAt === "number" ? record.createdAt : record.createdAt.getTime();
  const why = record.error === undefined ? "" : `: ${record.error.message}`;
  return `${record.workflowName} ${record.status} (started ${new Date(startedAt).toISOString()})${why}`;
}
