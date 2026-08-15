// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai workflow` — reading and steering a deployed agent's durable runs from a
 * terminal.
 *
 * A run outlives every surface that can show it: the studio's runs card is one
 * project's, and a page holds only the id it started. Without this the only way
 * to ask "what has this agent been doing" is to hand-build a `curl` against
 * `/:slug/workflows`, which needs the platform origin and the PUBLISHED slug —
 * neither of which is the project's name.
 *
 * **It talks to the platform's brokered route, unauthenticated by default**,
 * which is the same posture the page has: that surface carries no credential
 * unless the agent's operator set `AAI_WORKFLOW_API_TOKEN`, and `--token` is how
 * a caller passes it. So this is deliberately NOT an `apiRequest` — the caller's
 * API key is not what authorizes here, and sending it would put a platform
 * credential on a route that does not want one.
 *
 * Every request BROKERS, so the first one may boot the agent's sandbox. That is
 * the same trade the studio card makes and worth knowing before scripting a loop
 * around it.
 *
 * **The requests are the SDK's** (`createWorkflowApiClient`,
 * `@alexkroman1/aai/workflow-api`). What is left here is the two things that are
 * genuinely the CLI's: turning "this directory" into an origin plus a published
 * slug, and PRINTING — which is most of why the verbs exist separately from the
 * client's methods.
 */

import type { WorkflowRunSnapshot, WorkflowSummary } from "@alexkroman1/aai";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { createWorkflowApiClient, type WorkflowApi } from "@alexkroman1/aai/workflow-api";
import { getServerInfo } from "./_agent.ts";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

/**
 * One run, as the API reports it.
 *
 * The SDK's own type, not a restatement: this command prints `status`, `key` and
 * `error`, and a copy is how a field added to the snapshot silently stops being
 * printed. `WorkflowRunSnapshot` is a discriminated union, so `error` is
 * reachable only after narrowing — which is what {@link formatRun} does.
 */
type Run = WorkflowRunSnapshot;

/** Runs listed when the caller names no limit — a terminal is not a dashboard. */
const DEFAULT_RUN_LIMIT = 20;

/** What every verb here needs: a client aimed at the agent, and its slug to name. */
type Target = { api: WorkflowApi; slug: string };

type WorkflowOptions = { server?: string | undefined; token?: string | undefined };

/**
 * A client for the agent's workflow API, plus the bearer when one was given.
 *
 * `getServerInfo` is what turns "this directory" into an origin and a published
 * slug, and it already refuses a project that has never been deployed with the
 * sentence naming `aai publish`. The client is handed the AGENT's base URL and
 * appends the route prefix itself, so the `/workflows` literal is not spelled
 * here — it is the same constant the server matches on.
 *
 * `serverUrl` is joined as-is: `resolveServerUrl` is the single producer of
 * every origin that reaches here and strips trailing slashes once, at
 * resolution time, precisely so join sites do not each carry a copy. The copy
 * this used to hold also DISAGREED with it — `/\/$/` takes one slash where the
 * upstream `/\/+$/` takes all — so the two would have differed on the only
 * input either was written for.
 */
async function target(cwd: string, opts: WorkflowOptions): Promise<Target> {
  const { serverUrl, slug } = await getServerInfo(cwd, opts.server);
  return {
    api: createWorkflowApiClient({
      baseUrl: `${serverUrl}/${slug}`,
      ...omitUndefined({ token: opts.token }),
    }),
    slug,
  };
}

/**
 * Run one call, turning a rejection into a `CommandResult`.
 *
 * The client throws with the AGENT'S own sentence — an unknown workflow names
 * the declared ones, a 503 says the sandbox is still booting — and that text is
 * the whole diagnostic, so it is surfaced rather than replaced with a status
 * code. `errorMessage` rather than `instanceof Error`, because a rejection that
 * is message-bearing without being an `Error` would otherwise print as
 * `[object Object]`.
 */
async function attempt<T>(
  call: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** `aai workflow list` — what this agent declares. */
export async function executeWorkflowList(
  cwd: string,
  opts: WorkflowOptions,
): Promise<CommandResult<{ workflows: WorkflowSummary[] }>> {
  const { api, slug } = await target(cwd, opts);
  const res = await attempt(() => api.list());
  if (!res.ok) return fail("workflow_list_failed", res.error, HINT_BROKER);
  const workflows = res.value;
  if (workflows.length === 0) {
    log.info(`${slug} declares no workflows`);
  } else {
    for (const w of workflows) log.info(`${w.name}${w.description ? ` — ${w.description}` : ""}`);
  }
  return ok({ workflows });
}

/**
 * `aai workflow runs <name>` — recent runs, newest first.
 *
 * `recent` rather than `find`, so the query carries no `key`: a terminal has no
 * correlation key to ask about, and most runs carry none.
 */
export async function executeWorkflowRuns(
  cwd: string,
  workflow: string,
  opts: WorkflowOptions & { limit?: number | undefined },
): Promise<CommandResult<{ runs: Run[] }>> {
  const { api } = await target(cwd, opts);
  const res = await attempt(() => api.recent(workflow, { limit: opts.limit ?? DEFAULT_RUN_LIMIT }));
  if (!res.ok) return fail("workflow_runs_failed", res.error, HINT_BROKER);
  const runs = res.value;
  if (runs.length === 0) log.info(`No runs of ${workflow} yet`);
  for (const run of runs) log.info(formatRun(run));
  return ok({ runs });
}

/** One run on one line — the id first, because it is what every other verb takes. */
function formatRun(run: Run): string {
  const parts = [run.runId, run.status];
  if (run.key !== undefined) parts.push(`key=${run.key}`);
  if (run.status === "failed") parts.push(run.error);
  return parts.join("  ");
}

/** `aai workflow show <runId>` — one run in full, including its output. */
export async function executeWorkflowShow(
  cwd: string,
  runId: string,
  opts: WorkflowOptions,
): Promise<CommandResult<{ run: Run }>> {
  const { api } = await target(cwd, opts);
  const res = await attempt(() => api.get(runId));
  if (!res.ok) return fail("workflow_show_failed", res.error, HINT_BROKER);
  // `get` resolves undefined for a 404, which the API answers for BOTH an
  // unknown id and an agent that serves no workflow API at all — so the sentence
  // cannot claim to know which, and `HINT_BROKER` already names every cause.
  // (The status is the client's documented contract, not something to work
  // around: a caller reading an id it just started legitimately races the run's
  // creation, which is why it is an answer rather than a rejection.)
  if (res.value === undefined) {
    return fail("workflow_show_failed", `No run ${runId}`, HINT_BROKER);
  }
  const run = res.value;
  log.info(formatRun(run));
  // The output is the reason `show` exists next to `runs`, and it is the one
  // field a line cannot hold — printed as JSON so a shell can pipe it.
  if (run.status === "completed") log.info(JSON.stringify(run.output, null, 2));
  return ok({ run });
}

/** `aai workflow cancel <runId>` — stop a live run. */
export async function executeWorkflowCancel(
  cwd: string,
  runId: string,
  opts: WorkflowOptions,
): Promise<CommandResult<{ runId: string; cancelled: boolean }>> {
  const { api } = await target(cwd, opts);
  const res = await attempt(() => api.cancel(runId));
  if (!res.ok) return fail("workflow_cancel_failed", res.error, HINT_BROKER);
  const cancelled = res.value;
  // Not a failure when false: the run was already terminal, which is an ANSWER —
  // the same reason the route replies 200 either way.
  log.info(cancelled ? `Cancelled ${runId}` : `${runId} had already finished`);
  return ok({ runId, cancelled });
}

/**
 * The hint every failure here carries.
 *
 * Three causes dominate and they look similar from a terminal: the agent
 * declares no workflows (404 from its own API), its sandbox is still booting
 * (503 from the broker), or its operator closed the surface (401). Naming all
 * three is cheap and cannot be wrong — the same reasoning
 * `WORKFLOWS_UNAVAILABLE_MESSAGE` follows.
 */
const HINT_BROKER =
  "The agent may declare no workflows, or its sandbox may still be starting — try again shortly. " +
  "Pass --token if the agent sets AAI_WORKFLOW_API_TOKEN.";
