// Copyright 2026 the AAI authors. MIT license.
/**
 * One door for a queue message the PLATFORM delivered, and the reason it is not
 * the two routes the DevKit's own queue uses.
 *
 * `/.well-known/workflow/v1/{flow,step}` are the queue callbacks, and they are
 * refused from any peer that is not loopback (`handleWorkflowRequest`) — the
 * gate that closed an unauthenticated hole on every deployed agent's public
 * tunnel. A platform-owned queue lives OUTSIDE the container, so it needs a way
 * in, and there were two shapes available:
 *
 * - Widen the flow/step gate to also accept the platform's bearer. The platform
 *   then has to decide which of the two a message is, which means the DevKit's
 *   queue-name grammar has to be reimplemented in `aai-server` — a third-party
 *   grammar duplicated across a package boundary, on the side that does not
 *   depend on the DevKit and so cannot notice when it changes.
 * - One door the platform POSTs every message to, which dispatches by that
 *   grammar HERE, where the DevKit is a declared dependency and moves with it.
 *
 * This is the second. The platform's delivery is then a dumb forward — body,
 * three headers, a bearer — and the two loopback-only routes keep the gate they
 * have. The classification is the only thing that has to be right, and it fails
 * LOUDLY (400, naming the queue name) rather than guessing a route.
 *
 * ## It is `host-only`, and refused by default
 *
 * `GUEST_ROUTE_EXPOSURE.workflowQueue` declares it `host-only`: the platform
 * dials it over the sandbox tunnel with this sandbox's manage bearer, and no
 * client ever does. Authentication is INJECTED (`allowRemote`), because this
 * package is also what a self-hoster runs and the platform credential is not its
 * business. A composition that supplies no predicate refuses the route outright
 * — which is correct for `aai dev`, host mode and a self-hosted server, none of
 * which have a platform-owned queue.
 */

// Type-only, so this module stays the leaf it was: the door REPORTS a park and
// never resolves a logger of its own.
import type { Logger } from "./runtime-config.ts";
// The park CADENCE — how long a busy run asks to be brought back, and the line
// that says so. Its own module because the door decides whether a delivery may
// walk and that decides what to answer one that may not; see its module doc.
import { reportPark } from "./workflow-queue-park.ts";

/**
 * The platform's delivery door.
 *
 * Deliberately NOT under `/.well-known/workflow/v1/` — that prefix is the
 * DevKit's own namespace and a future version of it may add routes there; this
 * one is ours. It is also not under `/workflows`, which is the run API a caller
 * uses (`WORKFLOW_API_PREFIX`), and whose gate answers a different question.
 *
 * @internal
 */
export const WORKFLOW_QUEUE_PATH = "/workflow-queue";

/**
 * The header the DevKit's queue puts the queue name in, and the only thing that
 * says whether a message is a run replay or one step.
 *
 * The three `x-vqs-*` headers are the queue↔executor contract
 * (`executeMessageOverHttp` in `@workflow/world-postgres`); a platform-owned
 * queue reproduces them, and this is the one that decides routing.
 *
 * @internal
 */
export const QUEUE_NAME_HEADER = "x-vqs-queue-name";

/**
 * The runs this process is walking right now, mapped to WHEN each walk started.
 *
 * Module-scope because the scope is right: a guest serves every run of its slug
 * from one process, and this door is the only way a platform delivery gets in.
 * Same shape as `aai-studio-server/studio-workspace.ts`'s `workspaceLock`.
 *
 * It was a `Set<string>`, and the timestamp is what makes a park REPORTABLE
 * rather than merely correct — see {@link reportPark}. The elapsed time is the
 * one number that separates the two states a park is consistent with, and the
 * door is the only place that holds it: the walk itself is an `await` in a
 * promise nobody is measuring.
 */
const walking = new Map<string, number>();

/**
 * The DevKit's queue-name prefix, up to the kind — `__[<namespace>_]wkf_`.
 *
 * MODULE-LOCAL, and it used to leave the package: the two patterns below were
 * `@internal` exports on `aai-runtime/internal` because the platform's delivery
 * claim applied the same grammar inside Postgres, as `~ $n` against a pattern
 * crossing as a SQL parameter. It does not any more — a queue row carries a
 * `kind` column, written from {@link queueNameKind} at enqueue
 * (`aai-server/workflow-queue-store.ts`), so the grammar is applied exactly once
 * per message, here, and the claim reads a value. The one-source-of-truth
 * argument that put these strings on a public subpath is what retires them from
 * it: there is no longer a second engine to feed.
 *
 * A capturing group rather than `(?:` is a leftover of that arrangement —
 * Postgres's `~` does not accept the non-capturing form — and stays, because
 * {@link queueNameKind} reads no group and the alternative is a diff with no
 * behaviour in it.
 */
const QUEUE_NAME_GRAMMAR = "^__([a-z][a-z0-9]*_)?wkf_";

/** The grammar narrowed to ORCHESTRATION messages — the run's journal replay. */
const WORKFLOW_QUEUE_NAME_PATTERN = `${QUEUE_NAME_GRAMMAR}workflow_.+$`;

/**
 * The grammar narrowed to STEP messages — one step's execution.
 *
 * **The two patterns are EXHAUSTIVE, and nothing falls back to either.** The
 * platform's claim splits the due set with one apiece — orchestration serialized
 * per run, steps fanned out — and a name matching neither is refused rather than
 * classified: {@link queueNameKind} answers `undefined`, this module's dispatch
 * answers 400, and the platform's enqueue handler answers 400 before the row is
 * ever stored. So the claim has no third case to have an opinion about.
 *
 * It briefly had one — an unmatched name was treated as orchestration, on the
 * argument that serializing an unknown kind is the safe error. It is not a safe
 * error, it is a SILENT one: the reason a name would stop matching is a DevKit
 * that renamed a topic, and the whole fleet's step concurrency quietly returning
 * to one is exactly the regression this split exists to undo (#1284 + #1297),
 * found with a stopwatch because nothing failed. Refusing at the boundary is the
 * loud version of the same caution.
 *
 * Both require an id after the kind (`.+$`), so this and {@link queueNameKind}
 * cannot disagree about the bare prefix.
 */
const STEP_QUEUE_NAME_PATTERN = `${QUEUE_NAME_GRAMMAR}step_.+$`;

/** Compiled once; the strings above exist only to build these. */
const WORKFLOW_QUEUE_NAME_RE = new RegExp(WORKFLOW_QUEUE_NAME_PATTERN);
const STEP_QUEUE_NAME_RE = new RegExp(STEP_QUEUE_NAME_PATTERN);

/**
 * Which handler a queue name belongs to, or undefined when it is not one.
 *
 * The grammar is the DevKit's — `__[<namespace>_]wkf_(workflow|step)_<id>`, from
 * `parseQueueName` in `@workflow/world`. It is matched here rather than imported
 * because `@workflow/world` is a transitive dependency this package does not
 * declare and `workflow` does not re-export it; the shape is one line, and the
 * cost of it drifting is bounded by every caller REFUSING rather than picking a
 * route or a serialization domain.
 *
 * Written as two tests over the two patterns rather than one regex with an
 * alternation, because the alternation version had a real bug: the namespace
 * group is capturing (POSIX ERE has no `(?:`), so reading `match[1]` classified
 * every name as unroutable and answered 400 to the whole queue.
 *
 * It is now the ONLY reader of that grammar in the system. The platform stores
 * what this answers as `workflow_queue.kind` and its claim compares the column,
 * so this function is both the router's classifier and the enqueue handler's
 * refusal — see {@link STEP_QUEUE_NAME_PATTERN} for why there is no third case.
 *
 * @internal
 */
export function queueNameKind(queueName: string | null): "workflow" | "step" | undefined {
  if (queueName === null) return;
  if (WORKFLOW_QUEUE_NAME_RE.test(queueName)) return "workflow";
  if (STEP_QUEUE_NAME_RE.test(queueName)) return "step";
}

/**
 * Serve one delivery from the platform's queue by re-walking the run.
 *
 * What arrives is a message the platform held on this run's behalf
 * — because a deployed guest's own timers die with the sandbox — and all it
 * carries that matters is WHICH run.
 *
 * ## The run id comes from the queue NAME, and from nothing else
 *
 * The name is `__wkf_workflow_<runId>` — composed by `queueNameFor` on the way
 * out and matched by the platform's claim to serialize orchestration per run — so
 * the id is already in the one field this door is routed by. Reading the payload
 * as a fallback was tried and removed: it couples this module to the SENDING
 * client for a case that cannot arise, since every message this engine can
 * receive is one it composed.
 *
 * A message whose name is a STEP topic therefore answers 400, which is right
 * rather than unfortunate: this engine executes a step inline during the walk and
 * never as its own message, so such a name can only be a DevKit-era message
 * still in flight across a deploy. 400 retires it instead of spending the whole
 * abandonment budget on it first.
 *
 * ## An unroutable message is a 400, and a failed replay a 500
 *
 * The distinction is what the platform's abandonment budget rests on. A 400 says
 * "do not retry this, it can never route" — a message with no id in it will not
 * grow one. A 500 says "the guest was up and could not finish", which is the case
 * a retry is for. Answering 400 for a real failure abandons a live run; answering
 * 500 for a corrupt message spends the whole budget on it and then abandons it
 * anyway, several minutes later.
 *
 * ## A run is walked once at a time, and the door is the only place that knows
 *
 * `QUEUE_DELIVERY_TIMEOUT_MS` (60s, `aai-server/workflow-queue-deliver.ts`)
 * aborts the platform's `fetch`, and an abort closes the RESPONSE — it does not
 * stop the walk. Nothing here is plumbed to the request's signal, `serveFetch`
 * merely `await`s this handler, and a promise is not cancellable, so a step
 * still running at 60s carries on to completion while the platform records the
 * delivery as failed and re-presents the message.
 *
 * On its own that would be harmless. What makes it expensive is that
 * `replayRun` reads the journal ONCE per walk, so a walk that starts before the
 * first one has journaled anything re-executes EVERY step of the run rather
 * than only the slow one. Measured on a deployed workflow app whose first step
 * ran 75s: the redelivery landed 61.15s after the first (60,000 abort plus
 * `RETRY_BACKOFF_MS[0]`), the second walk re-ran that step in full, and then —
 * on a run the first walk had already marked `completed` — re-ran the plan, all
 * four provider calls and the merge. Twice the provider bill, twice the temp
 * disk, and on a long recording a guest's `/tmp` is what runs out first.
 *
 * So a delivery for a run this process is already walking is PARKED rather than
 * walked: `{"timeoutSeconds": n}`, which the platform reads as "bring this back
 * later" and which **touches no attempt** (`reschedule` in
 * `aai-server/workflow-queue-store.ts` says so in those words — its UPDATE
 * writes `locked_at` and `available_at` and nothing else, so only the FIRST
 * delivery's 60s abort ever spends one of `QUEUE_MAX_ATTEMPTS`, and a walk of any
 * length parks at attempt 1 forever). `n` is
 * {@link queueDeliveryBusySeconds} of the elapsed walk rather than a constant,
 * and the platform HONOURS it up: `parkedFor` accepts any finite non-negative
 * number and `reschedule` clamps only at zero, so there is no ceiling on that
 * side to fit under. Three properties, and each is why it is a park rather than
 * one of the alternatives:
 *
 * - **The message SURVIVES.** Acking it would be the cheap answer and it throws
 *   away the only redelivery a dead walk has left — at-least-once is the whole
 *   contract, and the walk this defers to is one nothing can see the health of.
 * - **It spends no retry budget**, so a genuinely slow run cannot be abandoned
 *   for being slow. Answering a busy run's message with a 500, or blocking
 *   behind the walk until the platform's own 60s lapses again, both burn
 *   `QUEUE_MAX_ATTEMPTS` and end in an abandoned message.
 * - **It is REPORTED**, which it was not, and the omission cost more than the
 *   bug the park fixed. A park is correct and silent, and silence is what a
 *   wedge looks like — {@link reportPark} carries the measurement (a healthy
 *   660.8 MB upload took 3m21s on one run and 15m00s on the next, and its author
 *   cancelled the second 13 seconds before it landed, having had no output for
 *   fourteen minutes). Nothing is wrong with a run in this state; the defect was
 *   that nothing SAID so.
 * - **It is per PROCESS, which is exactly what it can promise.** Two replicas
 *   would each keep their own set — but the platform's claim serializes a run's
 *   orchestration messages, so there is only ever one message in flight for a
 *   run, and overlapping walks come from redelivery to ONE guest rather than
 *   from two guests at once. Do not read this as a distributed lock: the
 *   run-level lease with an expiry that WOULD be one — the same heartbeat
 *   `workflow-replay-step.ts` names as what would close its own residual — is
 *   not built, and this gate is not a substitute for it.
 *
 * @internal
 */
export async function deliverQueueMessage(
  deliver: (runId: string) => Promise<unknown>,
  request: Request,
  opts: {
    /**
     * Where a PARK is reported — see {@link reportPark}.
     *
     * Optional, matching `handleWorkflowRequest`'s own field, which defaults it
     * to `consoleLogger`. A spec that does not care passes none.
     */
    logger?: Logger | undefined;
  } = {},
): Promise<Response> {
  const queueName = request.headers.get(QUEUE_NAME_HEADER);
  const runId = runIdFromQueueName(queueName);
  if (runId === undefined) {
    return Response.json(
      { error: `no run id in delivery: ${queueName ?? "(absent)"}` },
      { status: 400 },
    );
  }
  // Checked BEFORE the walk is entered, and answered with a park rather than a
  // failure — see "A run is walked once at a time".
  const startedAt = walking.get(runId);
  if (startedAt !== undefined) {
    // REPORTED, because the park is otherwise the one state in this engine that
    // is both correct and indistinguishable from a hang — and the report is what
    // computes the delay, so the line and this body carry the same number. See
    // {@link reportPark} and {@link queueDeliveryBusySeconds}.
    return Response.json({ timeoutSeconds: reportPark(opts.logger, runId, startedAt) });
  }
  walking.set(runId, Date.now());
  try {
    await deliver(runId);
  } finally {
    // In a `finally`, so a walk that THREW does not wedge its run: the door
    // answers 500, the platform retries, and the retry must be able to walk.
    // A leaked entry is a PERMANENT park — every later delivery answered
    // "still busy" for a walk that ended — which is why the specs assert the
    // release behaviourally, by requiring the next delivery to walk.
    walking.delete(runId);
  }
  // The STATUS is not reported, and that is deliberate: the platform acks on a
  // 200 and a run that is merely still suspended has been fully served. Reporting
  // "suspended" as anything but success would have the queue retry a wait.
  return Response.json({ ok: true });
}

/** The id in `__[<ns>_]wkf_workflow_<id>`, or undefined when the name is not one. */
function runIdFromQueueName(queueName: string | null): string | undefined {
  if (queueName === null || queueNameKind(queueName) !== "workflow") return;
  const id = queueName.slice(queueName.indexOf("wkf_workflow_") + "wkf_workflow_".length);
  return id === "" ? undefined : id;
}
