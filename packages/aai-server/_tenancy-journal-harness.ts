// Copyright 2026 the AAI authors. MIT license.
/**
 * The reference semantics for `platform-workflow-journal.ts` and
 * `platform-workflow-journal-hooks.ts` — the twelve journal methods, in three
 * appliers over ONE tenant's bucket.
 *
 * Split three ways along the tables: runs, the per-step ledgers (steps,
 * attempts, sleeps), and the hook window. That is the same seam the code under
 * test has — `-hooks.ts` was already carved off `platform-workflow-journal.ts`
 * for the 500-line cap, and the hook half is a self-contained subject.
 *
 * Every case names the statement it mirrors, because a mistake here surfaces as
 * a property divergence and a reader has to be able to tell "the model is wrong
 * about this statement" from "the store leaked".
 *
 * ## {@link Targets} is the leak surface, written out
 *
 * Four of the six modelled leaks are a bucket choice, so instead of threading a
 * `Leak` flag through every applier the world computes one record per op naming
 * exactly which buckets each predicate resolves against. For the reference every
 * field is this tenant and nothing else; a leak widens one of them. Enumerating
 * them in a type is the point — it is a list of the tenancy predicates in the
 * journal, and a new statement that reaches a table has to add a field or
 * inherit one.
 */

import type { Answer, Op } from "./_tenancy-ops-harness.ts";
import { pair, type StateTables } from "./_tenancy-state-harness.ts";

export type Run = {
  runId: string;
  workflow: string;
  status: string;
  createdAt: number;
  input: string | undefined;
  output: string | undefined;
  error: string | undefined;
};
export type Step = {
  runId: string;
  key: string;
  name: string;
  status: string;
  output: string | undefined;
  error: string | undefined;
  attempts: number;
  finishedAt: number;
};
export type Sleep = {
  runId: string;
  key: string;
  wakeAt: number;
  woken: boolean;
  correlationId: string | undefined;
  kind: string;
};
export type Hook = {
  runId: string;
  key: string;
  token: string;
  delivered: boolean;
  payload: string | undefined;
  closed: boolean;
};
export type Attempt = { runId: string; key: string; n: number };

/** One tenant's bucket: the journal's five tables plus the other two stores'. */
export type Tables = StateTables & {
  runs: Map<string, Run>;
  steps: Map<string, Step>;
  attempts: Map<string, Attempt>;
  /**
   * Who holds a live charge, per step key — the map the real row keeps.
   *
   * Beside `attempts` rather than replacing it, because the CENSUS compares
   * `attempts` (a count per key) and the holder names are the walk's business,
   * not the tenant boundary's. This is what makes a re-claim by the same holder
   * answer the same number, which the count alone cannot express.
   */
  holders: Map<string, Set<string>>;
  sleeps: Map<string, Sleep>;
  hooks: Map<string, Hook>;
};

/**
 * Which buckets each tenancy predicate resolves against, for one op.
 *
 * For the reference every one of these is `[own]` or `own`. A leak widens
 * exactly one, which is what makes the negative controls surgical.
 */
export type Targets = {
  /** Buckets `getRun` may fall back to when its own has no such run. */
  runRead: readonly Tables[];
  /** Buckets `setStatus`'s `released` CTE deletes hooks from (`h.slug = $1`). */
  hookRelease: readonly Tables[];
  /** Buckets `deliverHook` searches for the token (`slug = $1`), own first. */
  hookDelivery: readonly Tables[];
  /** The bucket `claimAttempt`'s `on conflict (slug, run_id, key)` resolves in. */
  attempts: Tables;
  /** Buckets `discardSession` deletes EVENTS from. */
  events: readonly Tables[];
};

/** Mirrors `platform-workflow-journal.ts`'s `TERMINAL`. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export type RunOp = Extract<Op, { t: "createRun" | "getRun" | "listRuns" | "setStatus" }>;
export type StepOp = Extract<
  Op,
  { t: "appendStep" | "readSteps" | "claimAttempt" | "claimSleep" | "wakeSleeps" }
>;
export type HookOp = Extract<Op, { t: "claimHook" | "deliverHook" | "closeHook" }>;

/** Every hook of one run, gone — `setStatus`'s release, per bucket. */
function releaseHooks(targets: readonly Tables[], runId: string): void {
  for (const target of targets) {
    for (const [key, hook] of target.hooks) if (hook.runId === runId) target.hooks.delete(key);
  }
}

/** `createRun`, `getRun`, `listRuns`, `setStatus`. */
export function applyRunOp(t: Tables, op: RunOp, targets: Targets): Answer {
  switch (op.t) {
    case "createRun":
      // `insert … on conflict (slug, run_id) do nothing returning run_id`: the
      // `returning` IS the refusal, and the contract on all three backends is
      // that a taken id is rejected.
      if (t.runs.has(op.runId)) return { refused: "run-taken" };
      t.runs.set(op.runId, {
        runId: op.runId,
        workflow: op.workflow,
        status: "pending",
        createdAt: op.createdAt,
        input: op.input,
        output: undefined,
        error: undefined,
      });
      return { ok: undefined };
    case "getRun": {
      const found =
        t.runs.get(op.runId) ??
        targets.runRead.map((other) => other.runs.get(op.runId)).find((row) => row !== undefined);
      return { ok: found ? { ...found } : undefined };
    }
    case "listRuns":
      // `order by created_at desc, run_id desc limit $3`, as an explicit
      // descending comparator. `label` makes `created_at` distinct per run, so
      // the order is total and cannot depend on physical row layout.
      return {
        ok: [...t.runs.values()]
          .filter((run) => run.workflow === op.workflow)
          .sort((x, y) => y.createdAt - x.createdAt || (x.runId < y.runId ? 1 : -1))
          .slice(0, op.limit)
          .map((run) => ({ ...run })),
      };
    case "setStatus":
      return { ok: move(t, op, targets) };
    default:
      throw new Error("tenancy reference reached a run op it does not model");
  }
}

/**
 * `setStatus`: the compare-and-set, answering from the ROW COUNT rather than a
 * re-read (a read would race the next writer) — plus the release CTE, whose
 * `h.slug = $1` is a SEPARATE predicate and is the leak no text gate can see.
 */
function move(t: Tables, op: Extract<Op, { t: "setStatus" }>, targets: Targets): boolean {
  const run = t.runs.get(op.runId);
  if (!run || (op.expect && !op.expect.includes(run.status))) return false;
  run.status = op.status;
  // `coalesce($4::text::jsonb, output)` — a null parameter KEEPS the stored
  // value, so an absent field is not an erasure.
  if (op.result?.output !== undefined) run.output = op.result.output;
  if (op.result?.error !== undefined) run.error = op.result.error;
  // Only a TERMINAL move releases. A run going `running` still owns its tokens.
  if (TERMINAL.has(op.status)) releaseHooks(targets.hookRelease, op.runId);
  return true;
}

/** `appendStep`, `readSteps`, `claimAttempt`, `claimSleep`, `wakeSleeps`. */
export function applyStepOp(t: Tables, op: StepOp, targets: Targets): Answer {
  const key = "key" in op ? pair(op.runId, op.key) : "";
  switch (op.t) {
    case "appendStep": {
      // `on conflict (slug, run_id, key) do nothing` then READ BACK: the first
      // write wins and every later one is a read, which is what makes two
      // executions that both ran a step agree on what it returned.
      const stored = t.steps.get(key) ?? {
        runId: op.runId,
        key: op.key,
        name: `st-${op.key}`,
        status: op.status,
        output: op.output,
        error: undefined,
        attempts: 1,
        finishedAt: op.finishedAt,
      };
      t.steps.set(key, stored);
      const { runId: _runId, ...row } = stored;
      return { ok: { ...row } };
    }
    case "readSteps":
      return {
        ok: [...t.steps.values()]
          .filter((step) => step.runId === op.runId)
          .sort((x, y) => x.finishedAt - y.finishedAt || (x.key < y.key ? -1 : 1))
          .map(({ runId: _runId, ...row }) => ({ ...row })),
      };
    case "claimAttempt": {
      // ONE statement over ONE row, holding a MAP of holder to when it claimed —
      // `_workflow-journal-attempts.ts` carries the shape. What the model has to
      // reproduce is that a re-claim by a holder that already holds one answers
      // the SAME number, which a counter cannot.
      //
      // The EXPIRY is deliberately not modelled: these programs run in under a
      // second against a window of minutes, so nothing here can age out, and a
      // model that pruned on a clock would diverge from the arm on timing rather
      // than on tenancy. The conformance suite is where the window is tested.
      const bucket = targets.attempts;
      const holders = bucket.holders.get(key) ?? new Set<string>();
      holders.add(op.holder);
      bucket.holders.set(key, holders);
      bucket.attempts.set(key, { runId: op.runId, key: op.key, n: holders.size });
      return { ok: holders.size };
    }
    case "claimSleep": {
      // First write wins and later calls are READS — what stops a replay pushing
      // the deadline further out on every walk of the body.
      const stored = t.sleeps.get(key) ?? {
        runId: op.runId,
        key: op.key,
        wakeAt: op.wakeAt,
        woken: false,
        correlationId: op.correlationId,
        kind: op.kind,
      };
      t.sleeps.set(key, stored);
      const { runId: _runId, key: _key, ...row } = stored;
      return { ok: { ...row } };
    }
    case "wakeSleeps":
      return { ok: wake(t, op) };
    default:
      throw new Error("tenancy reference reached a step op it does not model");
  }
}

/**
 * The three refusals `wakeSleeps` makes as one `where`: an ELAPSED wait is not
 * one this call stopped, nor is an already-woken one, and a BARE wake reaches
 * ordinary sleeps only — so cutting a schedule short cannot also close an
 * approval window.
 */
function wake(t: Tables, op: Extract<Op, { t: "wakeSleeps" }>): number {
  const due = [...t.sleeps.values()].filter(
    (sleep) => sleep.runId === op.runId && !sleep.woken && sleep.wakeAt > op.now,
  );
  const matched = due.filter((sleep) =>
    op.correlationIds
      ? sleep.correlationId !== undefined && op.correlationIds.includes(sleep.correlationId)
      : sleep.kind === "sleep",
  );
  for (const sleep of matched) sleep.woken = true;
  return matched.length;
}

/** `claimHook`, `deliverHook`, `closeHook`. */
export function applyHookOp(t: Tables, op: HookOp, targets: Targets): Answer {
  switch (op.t) {
    case "claimHook":
      return claim(t, op);
    case "deliverHook":
      return { ok: deliver(targets.hookDelivery, op) };
    case "closeHook": {
      // `closed > 0 || existing === 0`: `false` ONLY when the window was already
      // ANSWERED, which is the caller's instruction to take the answered branch
      // instead. Closed unconditionally, a signal landing between the deadline
      // read and the close would be lost.
      const hook = t.hooks.get(pair(op.runId, op.key));
      if (hook?.delivered) return { ok: false };
      if (hook) hook.closed = true;
      return { ok: true };
    }
    default:
      throw new Error("tenancy reference reached a hook op it does not model");
  }
}

/**
 * The `union all` over the PRE-statement snapshot plus the CTE's own insert.
 *
 * `on conflict do nothing` with NO target absorbs both unique indexes — the
 * primary key and `(slug, token)` — so the row the statement then reports is
 * what decides whether the claim was ours. `mine` is the row matching this run
 * and key; anything else means the token is held by a different wait.
 */
function claim(t: Tables, op: Extract<Op, { t: "claimHook" }>): Answer {
  const key = pair(op.runId, op.key);
  const preOwn = t.hooks.get(key);
  const preToken = [...t.hooks.values()].find((hook) => hook.token === op.token);
  const candidates: Hook[] = [];
  if (!(preOwn || preToken)) {
    const inserted: Hook = {
      runId: op.runId,
      key: op.key,
      token: op.token,
      delivered: false,
      payload: undefined,
      closed: false,
    };
    t.hooks.set(key, inserted);
    candidates.push(inserted);
  }
  if (preOwn) candidates.push(preOwn);
  if (preToken && preToken !== preOwn) candidates.push(preToken);
  const mine = candidates.find((hook) => hook.runId === op.runId && hook.key === op.key);
  if (!mine) return { refused: "hook-token", holder: candidates[0]?.runId };
  const { runId: _runId, key: _key, ...row } = mine;
  return { ok: { ...row } };
}

/**
 * `where slug = $1 and token = $2 and delivered = false and closed = false`.
 *
 * Own bucket first even when leaking: a leak that answered from a neighbour
 * while the caller held a live window of its own would be caught by almost any
 * program, so the surgical variant is only observable once the caller holds
 * nothing under the token.
 */
function deliver(
  targets: readonly Tables[],
  op: Extract<Op, { t: "deliverHook" }>,
): string | undefined {
  for (const target of targets) {
    const hook = [...target.hooks.values()].find(
      (row) => row.token === op.token && !row.delivered && !row.closed,
    );
    if (!hook) continue;
    hook.delivered = true;
    hook.payload = op.payload;
    return hook.runId;
  }
  return undefined;
}
