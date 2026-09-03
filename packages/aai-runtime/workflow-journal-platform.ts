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
 *   `releaseAttempt` gives one back when the attempt ENDED without settling the
 *   step, which is what keeps that ceiling a bound on abandonment rather than on
 *   reaches; a retried release is harmless for the mirror reason, being floored.
 * - **`claimSleep` and `appendStep` answer with what is STORED**, not with what
 *   was sent. First write wins; a replay that recomputes `ctx.sleep("poll", 60_000)` must
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
 * ## It deliberately does NOT declare `resumableRuns`
 *
 * That method is how a LOCAL dispatcher recovers a run whose timer died with its
 * process — the boot sweep in `workflow-in-process.ts`. A deployed guest has no
 * such timer: `selectJournal` pairs this backend with `createPlatformDispatch`,
 * so a suspended run's schedule is a delayed message in the platform's queue, and
 * a message that goes missing is re-enqueued by `aai-server/
 * workflow-queue-reconcile.ts` — server-side, on an indexed query over the
 * platform's own `workflow_runs`, with a grace window and a per-run throttle a
 * guest could not implement. Declaring it here would put a SECOND recovery
 * mechanism beside that one, racing it, and a deployed guest has two copies of
 * this package (see that package's guide) — so "a sandbox boot per copy per boot"
 * is the cost, for a run the queue already has scheduled.
 *
 * The absence is therefore a claim rather than a gap, which is what makes the
 * boot sweep's warning safe to be loud: the one journal that skips it skips it on
 * purpose, and `workflow-journal-platform.test.ts` pins that.
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
import { shareByKey } from "./_journal-shared-reads.ts";
import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { platformResult } from "./platform-rpc.ts";
import type {
  HookRecord,
  JournalStore,
  RunRecord,
  RunStatus,
  SleepEntry,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";
import { JournalConflictError } from "./workflow-journal-types.ts";
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

/**
 * Methods whose 409 is a {@link JournalConflictError} rather than the store.
 *
 * **Scoped to `claimHook`, and the narrowness is the decision.** That is the one
 * method whose refusal `JournalStore` documents as typed, and the only one of
 * the two 409s reachable from a workflow BODY — which is where the distinction
 * is read: the engine treats a journal rejection as "the store is unavailable,
 * retry the delivery" unless it is a conflict, so a conflicted run needs the
 * type or it is retried until its delivery budget runs out.
 *
 * The route's other 409 is `createRun`'s duplicate run id, and mapping it here
 * would be dishonest rather than generous: the postgres arm refuses that with a
 * raw primary-key violation, so the type would be a promise only one arm keeps.
 * `createRun` is reached from `engine.start` and never from a body, so nothing
 * reads the difference. Type it in all three arms first, or not at all.
 */
const CONFLICT_METHODS = new Set(["claimHook"]);

/**
 * One call to the platform's journal route.
 *
 * `errorFor` is what keeps a refusal a refusal: every other non-2xx is the
 * store, and a retryable status already carries `PLATFORM_UNAVAILABLE_CODE`.
 */
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
    errorFor: (status, detail) =>
      status === 409 && CONFLICT_METHODS.has(method)
        ? new JournalConflictError(`workflow-journal ${method} refused: ${detail.slice(0, 500)}`)
        : undefined,
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
    // A DIAGNOSTIC, so an absent or non-string value reads as unknown rather
    // than being coerced: `String(undefined)` is `"undefined"`, which would
    // compare unequal to every real bundle hash and make the divergence message
    // report a redeploy on a run that never had one.
    ...(typeof value.codeVersion === "string" ? { codeVersion: value.codeVersion } : {}),
  };
}

/**
 * A settled step off the wire, or undefined when the answer is not one.
 *
 * CHECKED, for the reason {@link toStatus} is, and here the check is what makes
 * `appendStep`'s refusal reachable at all. Accepting any record turned
 * `String(value.key)` into `"undefined"` and `Number(value.attempts)` into
 * `NaN`, so the one answer that must never be invented — the STORED entry, which
 * is what makes a double execution deterministic — was invented for anything
 * record-shaped, and the guard below it could only ever fire on `null`. The
 * three fields tested are the three that identify the entry; `output` is
 * legitimately absent and `error` legitimately so on an `ok` step.
 */
function toStep(value: unknown): StepEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.key !== "string" || typeof value.name !== "string") return undefined;
  if (value.status !== "ok" && value.status !== "failed") return undefined;
  const attempts = Number(value.attempts);
  const finishedAt = Number(value.finishedAt);
  if (!(Number.isFinite(attempts) && Number.isFinite(finishedAt))) return undefined;
  // NOT part of the refusal above, unlike `attempts` and `finishedAt`. An
  // absent start is legitimate — a row written before the column existed — so a
  // missing one must read as unknown rather than sink the whole entry, which is
  // the answer that makes a double execution deterministic. A present-but-junk
  // value is dropped the same way for the same reason: nothing downstream reads
  // it to make a decision, so refusing the entry over it would trade a durable
  // answer for a diagnostic.
  const startedAt = value.startedAt === undefined ? undefined : Number(value.startedAt);
  return {
    key: value.key,
    name: value.name,
    status: value.status,
    output: decode(value.output),
    error: errorOf(value.error),
    attempts,
    ...(startedAt !== undefined && Number.isFinite(startedAt) ? { startedAt } : {}),
    finishedAt,
  };
}

/**
 * A durable wait off the wire.
 *
 * Field by field rather than a cast, for the reason {@link toStep} is — and note
 * every read here is TOTAL: an unreadable `wakeAt` becomes `NaN`, which every
 * `now >= wakeAt` comparison answers `false` to, so a garbled record reads as
 * "not elapsed" and the wait round-trips exactly as it did before the snapshot
 * existed. That is the safe direction, and it is the same asymmetry `readStep`
 * records: this answer only ever SKIPS a round trip.
 */
function toSleep(value: Record<string, unknown>): SleepRecord {
  return {
    wakeAt: Number(value.wakeAt),
    woken: value.woken === true,
    correlationId: typeof value.correlationId === "string" ? value.correlationId : undefined,
    kind: value.kind === "hookTimeout" ? "hookTimeout" : "sleep",
  };
}

/**
 * Build the platform-backed journal.
 *
 * @internal
 */
export function createPlatformJournal(opts: PlatformEndpoint): JournalStore {
  // The two reads that are pure functions of a run id, so concurrent callers
  // share one round trip — see `_journal-shared-reads.ts` for what
  // issues them at once and why this is a coalescer rather than a cache. Built
  // per client, so two journals never share an entry.
  const sharedGetRun = shareByKey(
    async (runId: string): Promise<RunRecord | undefined> =>
      toRun(await call(opts, "getRun", { runId })),
  );
  const sharedReadSteps = shareByKey(async (runId: string): Promise<StepEntry[]> => {
    const rows = await call(opts, "readSteps", { runId });
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const step = toStep(row);
      return step ? [step] : [];
    });
  });
  // The THIRD read that is a pure function of a run id, and it is taken at the
  // same moment as the step read — so overlapping walks of one run share it for
  // exactly the reason they share that one.
  const sharedReadSleeps = shareByKey(async (runId: string): Promise<SleepEntry[]> => {
    const rows = await call(opts, "readSleeps", { runId });
    if (!Array.isArray(rows)) return [];
    // A row with no `key` is DROPPED rather than guessed at: an absent wait
    // round-trips through `claimSleep`, which is what happened before this read
    // existed. Same asymmetry as `readStep`.
    return rows.flatMap((row) =>
      isRecord(row) && typeof row.key === "string" ? [{ ...toSleep(row), key: row.key }] : [],
    );
  });

  return {
    async createRun(record: RunRecord): Promise<void> {
      await call(opts, "createRun", {
        runId: record.runId,
        workflow: record.workflow,
        status: record.status,
        createdAt: record.createdAt,
        input: encode(record.input),
        codeVersion: record.codeVersion,
      });
    },

    async getRun(runId: string): Promise<RunRecord | undefined> {
      return await sharedGetRun(runId);
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
      return await sharedReadSteps(runId);
    },

    async readStep(runId: string, key: string): Promise<StepEntry | undefined> {
      // NOT routed through `shareByKey` like the read above: that coalescer keys
      // on a run id, and this asks about one step of one — and the call site
      // (`settledSince`) reaches it once per contended step, never in the
      // concurrent burst a coalescer exists for.
      //
      // An UNREADABLE answer reads as "not settled" here, where `appendStep`
      // refuses one — the asymmetry is deliberate and matches `readSteps`, which
      // drops a row it cannot parse. This answer only ever SKIPS work, so
      // failing to read it re-runs a step, which is what at-least-once already
      // permits; `appendStep`'s answer decides what a double execution RETURNS,
      // where a guess is a divergence.
      return toStep(await call(opts, "readStep", { runId, key }));
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

    async releaseAttempt(runId: string, key: string): Promise<void> {
      // Nothing to validate: the answer is that the release happened, and the
      // call rejects when it did not. A charge that is not given back only
      // brings a step's ceiling closer, which is the safe direction.
      await call(opts, "releaseAttempt", { runId, key });
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
      return toSleep(row);
    },

    async readSleeps(runId: string): Promise<SleepEntry[]> {
      return await sharedReadSleeps(runId);
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

    async closeHook(runId: string, key: string): Promise<boolean> {
      // `=== true` and not a truthiness test, so an answer this backend cannot
      // read falls to the CONSERVATIVE side: `false` sends the engine to the
      // answered branch, which re-reads the hook and returns whatever is really
      // stored. Guessing `true` would be the divergence this method exists to
      // close, arriving by a different route.
      return (await call(opts, "closeHook", { runId, key })) === true;
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
          startedAt: entry.startedAt,
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
