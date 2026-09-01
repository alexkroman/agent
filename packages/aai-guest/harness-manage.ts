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
 * - The DevKit's workflow routes, which carry their OWN gates (loopback for the
 *   two queue callbacks, the injected predicate for the platform's door) and so
 *   must be claimed before anything here.
 * - `/workflows/*`, the run API, refused on a direct tunnel dial so the
 *   platform's rate limiters cannot be skipped.
 * - `/manage/*`: session count, drain, and this guest's own captured output.
 */

import type http from "node:http";
import { requestQuery } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { handleWorkflowRequest } from "@alexkroman1/aai-runtime/internal";
import { verifyBearer } from "./harness-auth.ts";
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (method === "GET" && url === MANAGE_STATUS_PATH) {
      sendJson(res, 200, {
        activeSessions: deps.activeSessions(),
        draining: deps.isDraining(),
        contractVersion: GUEST_CONTRACT_VERSION,
      });
      return true;
    }
    if (method === "POST" && url === MANAGE_DRAIN_PATH) {
      deps.startDrain(drainDeadlineMs(req));
      sendJson(res, 200, { ok: true, draining: true });
      return true;
    }
    // This guest's own stdout/stderr, by cursor. Served from here rather than
    // from the host because a buffer in host memory is readable on one replica
    // only — see harness-logs.ts.
    if (method === "GET" && url === MANAGE_LOGS_PATH) {
      const { after, limit } = parseLogQuery(requestQuery(req.url));
      sendJson(res, 200, guestLogBuffer().read(after, limit));
      return true;
    }
    sendJson(res, 404, { error: "not found" });
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
 * Settlement is the RESPONSE's `close`, which fires whether the handler answered
 * or the socket died, so a callback cannot leak the counter and pin a sandbox
 * alive forever. It is also the completion signal `handleWorkflowRequest` itself
 * does not give: it returns `true` synchronously and serves in the background.
 *
 * @internal
 */
export type WorkflowActivity = {
  /** Callbacks currently being served. */
  inFlight: () => number;
  /** Note one claimed workflow request; its response settles it. */
  begin: (res: http.ServerResponse) => void;
};

/**
 * Track in-flight workflow callbacks, so the idle controller can see them.
 *
 * A guest measures "nobody needs me" by its session count, which is the whole truth
 * for a voice agent and half of it for one with durable workflows: a run the
 * platform woke this sandbox to advance has NO session, so without this the sandbox
 * self-exits five minutes into an hour-long run.
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
    begin(res) {
      inFlight += 1;
      res.once("close", () => {
        inFlight -= 1;
      });
    },
  };
}

/**
 * Agent mode's whole `request` hook: the DevKit's queue callbacks, then the
 * manage surface.
 *
 * Workflows go FIRST because the paths are disjoint and this is the hotter one
 * on an agent that has any; unclaimed they would fall through to the server's
 * 404 and every run would stall with nothing saying why. The workflow surface is
 * read through a getter rather than passed by value because the bundle is loaded
 * before this is built but the two are independently replaceable, and a captured
 * `null` would leave a reloaded bundle's routes unmounted.
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
        ...omitUndefined({ deliver: deps.deliverWorkflow }),
      })
    ) {
      deps.activity?.begin(res);
      return true;
    }
    // Refuse a direct tunnel dial of the workflow API — it skips the platform's rate limiters (see harness-workflow-gate.ts); falls through on success.
    if (gateDirectWorkflowDial(req, res, url, deps.manage.token)) return true;
    return manage(req, res, url, method);
  };
}
