// Copyright 2026 the AAI authors. MIT license.
/**
 * `clientRunsRoutes()` — the "what is going on for this client" pair of
 * `agent({ routes })` handlers: a LIST of the runs a tool started for a
 * `?client=`, and a CANCEL of one of them.
 *
 * Every device-twin page wrote the same fifty lines for its "Running" panel:
 * `ctx.workflows.findByKey(clientId)`, keep what is still going plus what just
 * finished, read the newest progress line of a running one, say a failure the
 * way a speaker says it, and — the part that is a security decision rather
 * than plumbing — cancel a run only when its correlation key IS the asking
 * client, so one device cannot cancel another's reminder by guessing a run id.
 *
 * The runs are the ones a tool started with `key: ctx.clientId` (a run keyed by
 * anything else is not this client's, and is not listed). `useClientRuns` on
 * `@alexkroman1/aai-ui` is the page half, reading the {@link ClientRun} rows
 * this answers.
 *
 * **"Recently finished" is measured from CREATION.** A run snapshot carries its
 * `createdAt` and no finish time, so a finished run stays listed while it was
 * created less than `recentMs` ago — a ten-minute reminder that has just rung
 * is listed, a week-long watch that ended a moment ago is not.
 *
 * @module
 */

import { route } from "./agent-route-helpers.ts";
import { type RouteContext, type RouteHandler, routeResponse } from "./agent-routes.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { spokenErrorReason } from "./spoken-error-reason.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * A {@link ClientRun}'s status: a run's own, with `pending` said as
 * `waiting` — the word a person reads for "queued, not started".
 *
 * @public
 */
export type ClientRunStatus = "waiting" | "running" | "completed" | "failed" | "cancelled";

/**
 * One row of the list {@link clientRunsRoutes} answers — plain JSON, what a
 * page renders a run from.
 *
 * @public
 */
export interface ClientRun {
  /** The run's id — what the cancel route takes. */
  runId: string;
  /** The workflow's key in `agent({ workflows })`. */
  workflow: string;
  /** Where it has got to; see {@link ClientRunStatus}. */
  status: ClientRunStatus;
  /** The run's `label` (`StartOptions.label`), else its workflow's key. */
  title: string;
  /**
   * One line about it, when there is one: `options.detail`'s answer; else, for
   * a failed run, its error as `spokenErrorReason` says it (short, no URL, no
   * credential); else, for a running one, its newest progress line when that
   * is a string.
   */
  detail?: string;
  /** When the run was created, as epoch ms — the list is in this order, oldest first. */
  createdAt: number;
}

/**
 * The body the list route answers.
 *
 * @public
 */
export interface ClientRunsResponse {
  /** The client's runs, oldest first. */
  runs: ClientRun[];
}

/**
 * Options for {@link clientRunsRoutes}.
 *
 * @public
 */
export interface ClientRunsRoutesOptions {
  /**
   * The routes' path, as an `agent({ routes })` key spells it: the list is
   * `GET <path>`, the cancel `DELETE <path>/:runId`. Default `"/tasks"`.
   */
  path?: string;
  /**
   * A finished run is listed while it was created less than this long ago
   * (see the module doc for why creation). Pending and running runs are always
   * listed. Default 10 minutes.
   */
  recentMs?: number;
  /** Most runs read per request, newest first, before filtering. Default 100 (the ceiling). */
  limit?: number;
  /**
   * Whether to list this run at all, before the recent-window rule. Default:
   * every run. What drops a run that finished having decided to do nothing —
   * an event judged not worth telling anyone about.
   */
  include?: (run: WorkflowRunSnapshot) => boolean;
  /**
   * Whether to read this RUNNING run's newest progress line
   * (`ctx.workflows.lastLine`) for its `detail`. Default: every running run.
   * Each is one stream read per request, so narrow it to the workflows that
   * narrate. A line that cannot be read is simply not shown.
   */
  progressFor?: (run: WorkflowRunSnapshot) => boolean;
  /**
   * The run's `detail`, when you have a better one — a completed call's own
   * summary of what happened, say. `undefined` falls back to the defaults
   * {@link ClientRun.detail} lists.
   */
  detail?: (run: WorkflowRunSnapshot) => string | undefined;
}

/** The default {@link ClientRunsRoutesOptions.recentMs}: ten minutes. */
const DEFAULT_RECENT_MS = 10 * 60 * 1000;

/** The default {@link ClientRunsRoutesOptions.limit} — `findByKey`'s own ceiling. */
const DEFAULT_LIMIT = 100;

/** What cancelling a run that is not the asking client's answers, with a 404. */
const NOT_THIS_CLIENTS = "No such run for this client";

/**
 * A run's {@link ClientRun.detail} when `options.detail` gave none: a failure
 * as it would be SAID, else a running run's newest line when it is a string.
 */
async function defaultDetail(
  run: WorkflowRunSnapshot,
  ctx: RouteContext,
  progressFor: (run: WorkflowRunSnapshot) => boolean,
): Promise<string | undefined> {
  if (run.status === "failed") return spokenErrorReason(run.error);
  if (run.status !== "running" || !progressFor(run)) return undefined;
  // A line lost to a restart, or one that is not text, is simply not shown.
  const line = await ctx.workflows.lastLine(run.runId).catch(() => undefined);
  return typeof line === "string" ? line : undefined;
}

/**
 * The pair of routes a page's "Running" panel reads and cancels through —
 * `GET <path>` answering {@link ClientRunsResponse}, `DELETE <path>/:runId`
 * answering `{ cancelled }` — to spread into `agent({ routes })`. See this
 * module's doc.
 *
 * Both require `?client=` (a 400 without it). The cancel answers a 404 unless
 * the run's correlation key is that client, and `{ cancelled: false }` for a
 * run that had already finished.
 *
 * @example A speaker's running jobs, without the appEvent runs that told nobody
 * ```ts
 * import { agent, clientRunsRoutes } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Kitchen speaker",
 *   routes: {
 *     ...clientRunsRoutes({
 *       include: (r) =>
 *         !(r.workflow === "appEvent" && r.status === "completed" &&
 *           (r.output as { told?: unknown } | undefined)?.told !== true),
 *       progressFor: (r) => r.workflow === "research",
 *       // A call completes whether or not anyone answered: what it said is the result.
 *       detail: (r) => {
 *         const said = r.status === "completed" && r.workflow === "call"
 *           ? (r.output as { said?: unknown } | undefined)?.said
 *           : undefined;
 *         return typeof said === "string" ? said : undefined;
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @param options - The path, the window and the three per-run choices; see
 *   {@link ClientRunsRoutesOptions}.
 * @returns The two handlers, keyed `"GET <path>"` and `"DELETE <path>/:runId"`.
 *
 * @public
 */
export function clientRunsRoutes(
  options: ClientRunsRoutesOptions = {},
): Record<string, RouteHandler> {
  const path = options.path ?? "/tasks";
  if (!path.startsWith("/") || path.endsWith("/")) {
    throw new TypeError(
      `clientRunsRoutes: path must start with "/" and not end with one, got ${JSON.stringify(path)}`,
    );
  }
  const recentMs = options.recentMs ?? DEFAULT_RECENT_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const include = options.include ?? (() => true);
  const progressFor = options.progressFor ?? (() => true);

  const list = route({
    requireClient: true,
    handler: async (req, ctx): Promise<ClientRunsResponse> => {
      const now = Date.now();
      const listed = (await ctx.workflows.findByKey(req.clientId, { limit }))
        .filter(include)
        .filter(
          (r) => r.status === "pending" || r.status === "running" || now - r.createdAt < recentMs,
        );
      const runs = await Promise.all(
        listed.map(async (r): Promise<ClientRun> => {
          const detail = options.detail?.(r) ?? (await defaultDetail(r, ctx, progressFor));
          return {
            runId: r.runId,
            workflow: r.workflow,
            status: r.status === "pending" ? "waiting" : r.status,
            title: r.label ?? r.workflow,
            ...omitUndefined({ detail }),
            createdAt: r.createdAt,
          };
        }),
      );
      return { runs: runs.sort((a, b) => a.createdAt - b.createdAt) };
    },
  });

  const cancel = route({
    requireClient: true,
    handler: async (req, ctx) => {
      const runId = req.params.runId ?? "";
      // Only a run of THIS client: its correlation key is the client's id.
      if (runId === "" || (await ctx.workflows.get(runId))?.key !== req.clientId) {
        return routeResponse(404, { error: NOT_THIS_CLIENTS });
      }
      return { cancelled: await ctx.workflows.cancel(runId) };
    },
  });

  return { [`GET ${path}`]: list, [`DELETE ${path}/:runId`]: cancel };
}
