// Copyright 2026 the AAI authors. MIT license.
/**
 * The third {@link JournalStore}: the replay engine's journal over HTTP.
 *
 * A durable run's whole claim is that it outlives the process running it, and a
 * DEPLOYED run could not make it. The other two backends are a `Map` and a store
 * over the agent's own `DATABASE_URL`; the platform provisions no tenant database,
 * so every deployed run journaled into a sandbox that self-exits after
 * `AGENT_IDLE_EXIT_MS`. A step's result, its attempt count and an open approval
 * window died with it — and the run reported nothing, because from inside the
 * system a step whose result was lost is indistinguishable from one never reached.
 *
 * ## A third implementation, not a new design
 *
 * Every method here is one `POST` to `/:slug/workflow-journal`, and the platform
 * runs the SAME statements the self-hosted store does
 * (`aai-server/platform-workflow-journal.ts` mirrors `workflow-journal-schema.ts`,
 * with the slug added to every key). The three backends agreeing is what makes the
 * memory one a valid test double for the other two, so nothing here may
 * "helpfully" differ. Two agreements are the ones worth naming, because both are
 * silent when broken:
 *
 * - **`claimAttempt` is claimed BEFORE the body runs**, so a crash burns the
 *   attempt and a wedged step reaches its ceiling instead of retrying forever.
 *   That is a property of when the engine calls it, and this backend must not
 *   soften it by retrying the call itself — a retried claim would burn two.
 * - **`claimSleep` and `appendStep` answer with what is STORED**, not with what
 *   was sent. First write wins; a replay that recomputes `ctx.sleep(60_000)` must
 *   read back the original deadline or the run never wakes.
 *
 * ## The codec runs HERE, and the platform never sees a decoded value
 *
 * A run's `input`, a step's `output` and a hook's payload are author values that
 * may hold a `Uint8Array` or a `Date`, and `JSON.stringify` turns the first into
 * an index map with no error. So every one crosses as `workflow-typed-json.ts`
 * TEXT, exactly as the storage route's values do, and the platform stores that
 * text into a `jsonb` column without interpreting it. One codec, two sides, no
 * drift — and the platform cannot revive an envelope it did not write.
 *
 * ## What a failure does
 *
 * Every method propagates. The engine above has its own policy per call site and
 * it is not this module's to invent: a failed `claimAttempt` fails the delivery
 * (which is correct — the attempt may or may not have landed, and the ceiling is
 * the thing being protected), while a failed `setStatus` leaves the run where it
 * was, to be resolved by the next delivery.
 *
 * **A 501 is not special, and that is deliberate.** The platform answers it when
 * the deployment has no platform database, and this backend does not downgrade to
 * memory on reading one: the backend was chosen ONCE, from whether the boot env
 * named a platform, so there is nothing per request to re-decide. Silently
 * becoming memory is the exact failure this file exists to end.
 *
 * @internal
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { platformResult } from "./platform-rpc.ts";
import type {
  HookRecord,
  JournalStore,
  RunRecord,
  RunStatus,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";
import { decodeStorageJson, encodeStorageJson } from "./workflow-typed-json.ts";

/**
 * How long one journal call may take.
 *
 * A single indexed read or one upsert on the platform's database, over the
 * platform's own network — so this bounds a hung socket rather than real work.
 * Longer than session state's because a delivery is not a voice turn: nothing a
 * caller is waiting on is blocked behind it, and failing a step early costs an
 * attempt off its ceiling.
 */
const JOURNAL_TIMEOUT_MS = 15_000;

/** One call to the platform's journal route. */
async function call(
  opts: PlatformEndpoint,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return await platformResult(opts, {
    route: PLATFORM_ROUTES.workflowJournal,
    label: `workflow-journal ${method}`,
    timeoutMs: JOURNAL_TIMEOUT_MS,
    body: JSON.stringify({ method, ...body }),
  });
}

/** An author value on its way out. `undefined` stays absent rather than becoming null. */
const encode = (value: unknown): string | undefined =>
  value === undefined ? undefined : encodeStorageJson(value);

/** An author value on its way back. */
const decode = (value: unknown): unknown =>
  typeof value === "string" ? decodeStorageJson(value) : undefined;

/** An error message the platform stored, as the engine's shape. */
const errorOf = (value: unknown): { message: string } | undefined =>
  typeof value === "string" ? { message: value } : undefined;

/**
 * Every status a run can be in.
 *
 * Spelled here because `WorkflowRunStatus` is a type with no runtime companion —
 * `TERMINAL_WORKFLOW_STATUSES` covers three of the five. A status off the wire is
 * CHECKED rather than cast: this is our own platform, but it is still a boundary,
 * and a laundered `String(x) as RunStatus` would put an unknown status into the
 * engine's `expect` comparisons, where it silently matches nothing and a run stops
 * advancing with no error anywhere.
 */
const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

function toStatus(value: unknown): RunStatus | undefined {
  return RUN_STATUSES.find((status) => status === value);
}

/** A run off the wire. */
function toRun(value: unknown): RunRecord | undefined {
  if (!isRecord(value)) return undefined;
  const status = toStatus(value.status);
  if (status === undefined) return undefined;
  return {
    runId: String(value.runId),
    workflow: String(value.workflow),
    status,
    createdAt: Number(value.createdAt),
    input: decode(value.input),
    output: decode(value.output),
    error: errorOf(value.error),
  };
}

/** A settled step off the wire. */
function toStep(value: unknown): StepEntry | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status === "failed" ? "failed" : "ok";
  return {
    key: String(value.key),
    name: String(value.name),
    status,
    output: decode(value.output),
    error: errorOf(value.error),
    attempts: Number(value.attempts),
    finishedAt: Number(value.finishedAt),
  };
}

/**
 * Build the platform-backed journal.
 *
 * @internal
 */
export function createPlatformJournal(opts: PlatformEndpoint): JournalStore {
  return {
    async createRun(record: RunRecord): Promise<void> {
      await call(opts, "createRun", {
        runId: record.runId,
        workflow: record.workflow,
        status: record.status,
        createdAt: record.createdAt,
        input: encode(record.input),
      });
    },

    async getRun(runId: string): Promise<RunRecord | undefined> {
      return toRun(await call(opts, "getRun", { runId }));
    },

    async listRuns(workflow: string, limit: number): Promise<RunRecord[]> {
      const rows = await call(opts, "listRuns", { workflow, limit });
      if (!Array.isArray(rows)) return [];
      // A row that will not parse is DROPPED rather than guessed at: the caller is
      // a listing, and one malformed row must not fail the page.
      return rows.flatMap((row) => {
        const run = toRun(row);
        return run ? [run] : [];
      });
    },

    async setStatus(
      runId: string,
      next: RunStatus,
      patch?: { output?: unknown; error?: { message: string } },
      expect?: readonly RunStatus[],
    ): Promise<boolean> {
      return (
        (await call(opts, "setStatus", {
          runId,
          status: next,
          output: encode(patch?.output),
          error: patch?.error?.message,
          expect,
        })) === true
      );
    },

    async readSteps(runId: string): Promise<StepEntry[]> {
      const rows = await call(opts, "readSteps", { runId });
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        const step = toStep(row);
        return step ? [step] : [];
      });
    },

    async claimAttempt(runId: string, key: string): Promise<number> {
      const n = await call(opts, "claimAttempt", { runId, key });
      if (typeof n !== "number") {
        // Never invented. An attempt number the caller made up is a ceiling that
        // does not hold, which is the one thing this primitive exists to provide.
        throw new Error(`workflow-journal claimAttempt answered ${typeof n} for ${runId}`);
      }
      return n;
    },

    async claimSleep(
      runId: string,
      key: string,
      wakeAt: number,
      correlationId: string | undefined,
      kind: SleepRecord["kind"] = "sleep",
    ): Promise<SleepRecord> {
      const row = await call(opts, "claimSleep", { runId, key, wakeAt, correlationId, kind });
      if (!isRecord(row))
        throw new Error(`workflow-journal claimSleep answered nothing for ${key}`);
      return {
        wakeAt: Number(row.wakeAt),
        woken: row.woken === true,
        correlationId: typeof row.correlationId === "string" ? row.correlationId : undefined,
        kind: row.kind === "hookTimeout" ? "hookTimeout" : "sleep",
      };
    },

    async wakeSleeps(
      runId: string,
      correlationIds: readonly string[] | undefined,
    ): Promise<number> {
      // `now` crosses the wire because the engine's clock is the one that decides
      // whether a wait has elapsed. Letting the DATABASE compare against its own
      // would put a second clock in the one place replay determinism rests on.
      const woken = await call(opts, "wakeSleeps", { runId, now: Date.now(), correlationIds });
      return typeof woken === "number" ? woken : 0;
    },

    async claimHook(runId: string, key: string, token: string): Promise<HookRecord> {
      const row = await call(opts, "claimHook", { runId, key, token });
      if (!isRecord(row)) throw new Error(`workflow-journal claimHook answered nothing for ${key}`);
      return {
        token: String(row.token),
        delivered: row.delivered === true,
        payload: decode(row.payload),
        closed: row.closed === true,
      };
    },

    async closeHook(runId: string, key: string): Promise<void> {
      await call(opts, "closeHook", { runId, key });
    },

    async deliverHook(token: string, payload: unknown): Promise<string | undefined> {
      const runId = await call(opts, "deliverHook", { token, payload: encode(payload) });
      return typeof runId === "string" ? runId : undefined;
    },

    async appendStep(runId: string, entry: StepEntry): Promise<StepEntry> {
      const row = await call(opts, "appendStep", {
        runId,
        entry: {
          key: entry.key,
          name: entry.name,
          status: entry.status,
          output: encode(entry.output),
          error: entry.error?.message,
          attempts: entry.attempts,
          finishedAt: entry.finishedAt,
        },
      });
      const stored = toStep(row);
      // The AUTHORITATIVE entry, which is what makes a double execution
      // deterministic — so an unreadable answer is a failure rather than a fall
      // back to the entry we sent, which may not be the one that is stored.
      if (!stored) throw new Error(`workflow-journal appendStep answered nothing for ${entry.key}`);
      return stored;
    },
  };
}
