// Copyright 2026 the AAI authors. MIT license.
/**
 * A deployed guest's whole HTTP surface for the PLATFORM, and nothing else.
 *
 * Split out of `harness-agent-mode.ts` when the queue-delivery door pushed that
 * file past its length cap. The seam is the right one anyway: everything here is
 * about a request the platform makes, gated by the per-sandbox bearer, while what
 * is left there is this guest's own LIFECYCLE — reading its boot artifacts,
 * counting its sessions, and deciding when to exit. Those two are edited for
 * unrelated reasons.
 *
 * Three surfaces, and they compose in `createAgentRequestHandler` in the order
 * their gates demand:
 *
 * - `POST /workflow-queue`, the platform's delivery door. It carries its OWN
 *   gate — the injected `allowRemote` predicate — and so must be claimed before
 *   anything here. It was three routes under the DevKit, two of them the world's
 *   own loopback-gated queue callbacks; the replay engine executes a step inline
 *   during the walk, so only the delivery is left.
 * - `/workflows/*`, the run API, refused on a direct tunnel dial so the
 *   platform's rate limiters cannot be skipped.
 * - `/manage/*`: session count, drain, and this guest's own captured output.
 */

import type http from "node:http";
import { requestQuery } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { handleWorkflowRequest } from "@alexkroman1/aai-runtime/internal";
import { verifyBearer } from "./harness-auth.ts";
import { writeJson } from "./harness-http.ts";
import { guestLogBuffer, parseLogQuery } from "./harness-logs.ts";
import { gateDirectWorkflowDial } from "./harness-workflow-gate.ts";
import { GUEST_CONTRACT_VERSION } from "./limits.ts";

/** Paths of the token-gated management surface. */
export const MANAGE_STATUS_PATH = "/manage/status";
export const MANAGE_DRAIN_PATH = "/manage/drain";
export const MANAGE_LOGS_PATH = "/manage/logs";

export type ManageDeps = {
  /** The per-sandbox bearer (AAI_GUEST_TOKEN) gating this surface. */
  token: string;
  /** Live client-session count (the harness state's counter). */
  activeSessions: () => number;
  /** True once a drain was requested. */
  isDraining: () => boolean;
  /**
   * Request a drain: refuse new sessions, exit when the last one ends —
   * or at `deadlineMs` from now regardless (the host's retire budget; a
   * drained guest is superseded code, so it must not outlive one long
   * call indefinitely). Absent deadline: drain until empty.
   */
  startDrain: (deadlineMs?: number) => void;
};

/**
 * The drain deadline off the request's query (`?deadlineMs=600000`). A query
 * param rather than a body: the server's request hook hands over a
 * query-stripped path, so the raw `req.url` is the one place the value
 * rides, and a number in a query needs no body reader, no size cap, and no
 * JSON parsing. Absent/malformed reads as "drain until empty".
 */
function drainDeadlineMs(req: http.IncomingMessage): number | undefined {
  const raw = requestQuery(req.url).get("deadlineMs");
  const ms = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The `request` hook serving `/manage/*`. Claims every `/manage` path
 * (unauthenticated ones with a 401 — the tunnel URL is public, the bearer is
 * what keeps this from being an open door), leaves everything else to the
 * server's own routing.
 */
export function createManageHandler(
  deps: ManageDeps,
): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  return (req, res, url, method) => {
    if (!url.startsWith("/manage/")) return false;
    if (!verifyBearer(req.headers.authorization, deps.token)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (method === "GET" && url === MANAGE_STATUS_PATH) {
      writeJson(res, 200, {
        activeSessions: deps.activeSessions(),
        draining: deps.isDraining(),
        contractVersion: GUEST_CONTRACT_VERSION,
      });
      return true;
    }
    if (method === "POST" && url === MANAGE_DRAIN_PATH) {
      deps.startDrain(drainDeadlineMs(req));
      writeJson(res, 200, { ok: true, draining: true });
      return true;
    }
    // This guest's own stdout/stderr, by cursor. Served from here rather than
    // from the host because a buffer in host memory is readable on one replica
    // only — see harness-logs.ts.
    if (method === "GET" && url === MANAGE_LOGS_PATH) {
      const { after, limit } = parseLogQuery(requestQuery(req.url));
      writeJson(res, 200, guestLogBuffer().read(after, limit));
      return true;
    }
    writeJson(res, 404, { error: "not found" });
    return true;
  };
}

/**
 * Workflow work in flight, so the idle controller can see it.
 *
 * A guest measures "nobody needs me" by its session count, which is the whole
 * truth for a voice agent and half of it for one with durable workflows: a run the
 * platform delivered a queued message to (`aai-server/workflow-queue-sweep.ts`)
 * has NO session, so without this the sandbox self-exits five minutes into an
 * hour-long run — mid-step, leaving the message claimed until
 * `QUEUE_CLAIM_STALE_MS` lapses and a later sweep reclaims it. The delivery would
 * then have bought at most one idle window of progress per message.
 *
 * ## The unit is the WALK, and it used to be the HTTP RESPONSE
 *
 * That is the whole of the fix here, and the bug it closes made every step longer
 * than the idle window impossible to finish in production. Read
 * {@link createWorkflowActivity}.
 *
 * @internal
 */
export type WorkflowActivity = {
  /** Walks currently running. */
  inFlight: () => number;
  /**
   * Count one walk for as long as it RUNS, and answer its own promise.
   *
   * Takes the work rather than being told when it started, because "when it
   * ended" is the half a caller gets wrong: the settle has to be the walk's own
   * `finally` and nothing else.
   */
  walk: <T>(run: () => Promise<T>) => Promise<T>;
};

/**
 * Track running workflow WALKS, so the idle controller can see them.
 *
 * ## Keying on the response was a LIVELOCK, measured in production
 *
 * This used to take a `ServerResponse` and settle on its `close`, which is the
 * signal `handleWorkflowRequest` makes easy to reach — it returns `true`
 * synchronously and serves in the background — and it is not a signal about the
 * work at all. The platform aborts a delivery's `fetch` at
 * `QUEUE_DELIVERY_TIMEOUT_MS` (60s, `aai-server/workflow-queue-deliver.ts`), and
 * an abort closes the RESPONSE without stopping the walk: nothing here is plumbed
 * to the request's signal and a promise is not cancellable. So `inFlight` went to
 * zero 60 seconds into every long step while the step ran on, and the idle clock
 * started from there. Every parked redelivery afterwards answered instantly, so
 * it went 1 → 0 again in the same tick and never reset anything.
 *
 * From `modal app logs aai-server-web`, on a 552.4 MB upload:
 *
 * ```text
 * 12:10:38  Uploading … (552.4 MB) … uploadToProvider#0 attempt 1
 * 12:11:39  first park (walkingForSeconds ~61) — inFlight had already hit 0
 *    ...    parked redeliveries, each 1 -> 0 within a tick
 * 12:16:33  agent guest idle for 300000ms; exiting        <- MID-UPLOAD
 * 12:16:44  a NEW sandbox starts the SAME file's upload, attempt 1
 * ```
 *
 * 12:11:33 + `AGENT_IDLE_EXIT_MS` is 12:16:33 exactly. **A step longer than the
 * idle window therefore never completed** — it restarted from scratch in a fresh
 * sandbox, forever, and `TRANSCRIBE_UPLOAD_TIMEOUT_MS` (30 min) says a healthy
 * upload may legitimately outlive that window six times over.
 *
 * **The parking gate is what made it reachable**, which is worth recording rather
 * than blaming. Before it, each redelivery started its own concurrent walk, so
 * `inFlight` was non-zero for each 60s delivery and the guest survived — at the
 * price of re-running every step. Parking removed the duplicate work and removed
 * the accidental liveness signal with it.
 *
 * ## Why not count the PARK
 *
 * Because a park is evidence about a walk this door cannot see the health of. It
 * would keep the guest alive for the right reason exactly when a walk is alive
 * and for the wrong reason when one has died, and a dead walk parks forever — so
 * that trades a livelock for a leak. The walk's own promise is the only honest
 * answer, and it is the one the door already awaits.
 *
 * ## What a hung walk costs, said plainly
 *
 * A walk whose promise never settles pins this guest alive. That is deliberate: a
 * guest running work is not idle, and the alternative — crediting a walk for a
 * bounded time — is the livelock again with a longer fuse. The bound is the
 * sandbox's, `SANDBOX_TIMEOUT_SECS` (4h), which terminates it regardless; the
 * bound a step OUGHT to have is its own deadline, which is where a step's timeout
 * belongs.
 *
 * It used to notify an `onSettled` callback as each finished, which is where the
 * wake HINT was republished — a per-app timestamp the platform read to know when to
 * boot a guest. The platform reads its own queue now (`aai_platform.workflow_queue`
 * has a `slug` and an `available_at`, which the DevKit's schema did not), so there
 * is nothing to notify and the parameter is gone rather than left as a hook with no
 * caller.
 */
export function createWorkflowActivity(): WorkflowActivity {
  let inFlight = 0;
  return {
    inFlight: () => inFlight,
    async walk(run) {
      inFlight += 1;
      try {
        return await run();
      } finally {
        // The walk's OWN settle, which is the entire point — a `finally` here
        // cannot be reached by an aborted response, a park, or a socket that
        // died, none of which say anything about the body still running.
        inFlight -= 1;
      }
    },
  };
}

/**
 * Wrap the run-walker so every walk it starts counts as activity.
 *
 * Wrapping the WALKER rather than instrumenting the door is what keeps the
 * liveness signal where the work is: `deliverQueueMessage` awaits exactly this
 * promise, and a PARKED delivery never calls it at all — so a park is
 * uncounted by construction rather than by a check somebody has to remember.
 *
 * ## Why not read the ENGINE's own in-flight set
 *
 * `createWorkflowEngine` already keeps `Map<runId, Set<AbortController>>`, added
 * on walk start and cleared in a `finally` tied to `replayRun` — the same signal,
 * and the obvious place to ask. Two things rule it out, and the second is not a
 * preference:
 *
 * - **It is the BUNDLE's engine, not ours.** `harness-bundle.ts` resolves
 *   `deliverWorkflow` through `ensureRuntime`, which builds the runtime from the
 *   worker bundle's OWN `@alexkroman1/aai-runtime` (see "User-shipped runtime").
 *   So a new field on `AgentRuntime` is `undefined` on every already-deployed
 *   agent until it is rebuilt — the livelock would go on until each tenant
 *   redeployed. The walker's PROMISE is on every bundle that has the door at all,
 *   so wrapping it fixes the whole fleet the moment the guest image ships. (It
 *   would also owe a `runtime` epoch bump, which is the cheap half of the cost.)
 * - **The idle poll must not build a runtime.** It ticks every
 *   `AGENT_IDLE_POLL_MS` from before the bundle loads, and reading the runtime is
 *   what CONSTRUCTS it — `handleWorkflowRequest`'s `deliver` parameter carries
 *   what that cost when it was eager: `ensureRuntime` throws for a bundle that
 *   has not loaded, into a hook called with no `try`, so the guard exited the
 *   process and took every live voice session with it.
 *
 * The getter is preserved as a getter for that second reason. So the wrapper is
 * minted per resolution and closes over nothing but the walk.
 */
function trackWalks(
  deliver: (() => ((runId: string) => Promise<unknown>) | undefined) | undefined,
  activity: WorkflowActivity | undefined,
): (() => ((runId: string) => Promise<unknown>) | undefined) | undefined {
  if (deliver === undefined || activity === undefined) return deliver;
  return () => {
    const walk = deliver();
    return walk && ((runId: string) => activity.walk(() => walk(runId)));
  };
}

/**
 * Agent mode's whole `request` hook: the platform's delivery door, the direct-
 * dial gate on `/workflows/*`, then the manage surface.
 *
 * The delivery door goes FIRST because the paths are disjoint and this is the
 * hotter one on an agent that has workflows; unclaimed it would fall through to
 * the server's 404 and every scheduled run would stall with nothing saying why.
 * Why `deliverWorkflow` is a getter rather than a value is on the parameter.
 */
export function createAgentRequestHandler(deps: {
  manage: ManageDeps;
  /**
   * `AgentRuntime.deliverWorkflow` — re-walk one run for a platform delivery.
   *
   * A GETTER for the reason `workflows` is one: the harness builds its runtime on
   * the first thing that needs it, so a captured value is `undefined` for the
   * life of the process. Absent means this guest has no engine to deliver to, and
   * the door then answers as it did before — 404 for an agent with no workflows.
   *
   * This is the whole reason the door exists under the replay engine: a deployed
   * guest's own timers die with a sandbox that self-exits, so the platform's
   * queue holds the schedule and a due message boots the guest and lands here.
   */
  deliverWorkflow?: (() => ((runId: string) => Promise<unknown>) | undefined) | undefined;
  /** Absent leaves workflow work invisible to the idle controller — tests only. */
  activity?: WorkflowActivity | undefined;
}): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  const manage = createManageHandler(deps.manage);
  // Counted at the WALK, not at the request — see {@link trackWalks}. Composed
  // once, here, so the door below cannot be given the untracked walker by
  // accident.
  const deliverWorkflow = trackWalks(deps.deliverWorkflow, deps.activity);
  return (req, res, url, method) => {
    if (
      handleWorkflowRequest(req, res, url, method, {
        // The platform's queue-delivery door, vouched for by the same bearer the
        // rest of the manage surface uses — this IS a management operation the
        // platform performs on a guest, and `AAI_GUEST_TOKEN` is an HMAC over
        // this sandbox's fleet-wide name that a direct dialer cannot forge.
        //
        // Deliberately `Authorization` rather than the `x-aai-guest-token`
        // header `gateDirectWorkflowDial` reads: that one is a SECOND header
        // because `Authorization` there still carries the caller's own
        // `AAI_WORKFLOW_API_TOKEN` and the two gates compose. Here there is no
        // caller but the platform, so there is nothing to compose with and the
        // ordinary bearer is the honest spelling.
        allowRemote: (r) => verifyBearer(r.headers.authorization, deps.manage.token),
        // The getter itself, NOT its result: reading it builds the runtime, and
        // `handleWorkflowRequest` resolves it only after the path and the bearer.
        // Passed as a value it was evaluated on every request reaching this hook.
        ...omitUndefined({ deliver: deliverWorkflow }),
      })
    ) {
      // NOTHING is counted here any more. A claimed request is not work — the
      // walk it may start is, and it is counted for its own lifetime one layer
      // in. `deps.activity.begin(res)` used to sit on this line and is the
      // livelock `createWorkflowActivity` documents.
      return true;
    }
    // Refuse a direct tunnel dial of the workflow API — it skips the platform's rate limiters (see harness-workflow-gate.ts); falls through on success.
    if (gateDirectWorkflowDial(req, res, url, deps.manage.token)) return true;
    return manage(req, res, url, method);
  };
}
