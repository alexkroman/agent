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
 */

import type { WorkflowRunSnapshot, WorkflowSummary } from "@alexkroman1/aai";
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

/**
 * The agent's workflow endpoint, plus the bearer when one was given.
 *
 * `getServerInfo` is what turns "this directory" into an origin and a published
 * slug, and it already refuses a project that has never been deployed with the
 * sentence naming `aai publish`.
 */
async function endpoint(
  cwd: string,
  server: string | undefined,
  token: string | undefined,
): Promise<{ base: string; headers: Record<string, string>; slug: string }> {
  const { serverUrl, slug } = await getServerInfo(cwd, server);
  return {
    base: `${serverUrl.replace(/\/$/, "")}/${slug}/workflows`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    slug,
  };
}

/**
 * One request, with the agent's own error sentence preserved.
 *
 * That text is the whole diagnostic — an unknown workflow names the declared
 * ones, a 503 says the sandbox is still booting — so it is surfaced rather than
 * replaced with a status code.
 */
async function request<T>(
  url: string,
  headers: Record<string, string>,
  init: RequestInit = {},
): Promise<{ ok: true; body: T } | { ok: false; message: string }> {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      if (text) message = `${res.status}: ${text.slice(0, 200)}`;
    }
    return { ok: false, message };
  }
  return { ok: true, body: (await res.json()) as T };
}

/** `aai workflow list` — what this agent declares. */
export async function executeWorkflowList(
  cwd: string,
  opts: { server?: string | undefined; token?: string | undefined },
): Promise<CommandResult<{ workflows: WorkflowSummary[] }>> {
  const { base, headers, slug } = await endpoint(cwd, opts.server, opts.token);
  const res = await request<{ workflows?: WorkflowSummary[] }>(base, headers);
  if (!res.ok) return fail("workflow_list_failed", res.message, HINT_BROKER);
  const workflows = res.body.workflows ?? [];
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
 * No `key` on the query, so this is the KEYLESS read (`ctx.workflows.recent`): a
 * terminal has no correlation key to ask about, and most runs carry none.
 */
export async function executeWorkflowRuns(
  cwd: string,
  workflow: string,
  opts: { server?: string | undefined; token?: string | undefined; limit?: number | undefined },
): Promise<CommandResult<{ runs: Run[] }>> {
  const { base, headers } = await endpoint(cwd, opts.server, opts.token);
  const query = new URLSearchParams({
    workflow,
    limit: String(opts.limit ?? DEFAULT_RUN_LIMIT),
  });
  const res = await request<{ runs?: Run[] }>(`${base}/runs?${query.toString()}`, headers);
  if (!res.ok) return fail("workflow_runs_failed", res.message, HINT_BROKER);
  const runs = res.body.runs ?? [];
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
  opts: { server?: string | undefined; token?: string | undefined },
): Promise<CommandResult<{ run: Run }>> {
  const { base, headers } = await endpoint(cwd, opts.server, opts.token);
  const res = await request<Run>(`${base}/runs/${encodeURIComponent(runId)}`, headers);
  if (!res.ok) return fail("workflow_show_failed", res.message, HINT_BROKER);
  log.info(formatRun(res.body));
  // The output is the reason `show` exists next to `runs`, and it is the one
  // field a line cannot hold — printed as JSON so a shell can pipe it.
  if (res.body.status === "completed") log.info(JSON.stringify(res.body.output, null, 2));
  return ok({ run: res.body });
}

/** `aai workflow cancel <runId>` — stop a live run. */
export async function executeWorkflowCancel(
  cwd: string,
  runId: string,
  opts: { server?: string | undefined; token?: string | undefined },
): Promise<CommandResult<{ runId: string; cancelled: boolean }>> {
  const { base, headers } = await endpoint(cwd, opts.server, opts.token);
  const res = await request<{ cancelled?: boolean }>(
    `${base}/runs/${encodeURIComponent(runId)}`,
    headers,
    { method: "DELETE" },
  );
  if (!res.ok) return fail("workflow_cancel_failed", res.message, HINT_BROKER);
  const cancelled = res.body.cancelled === true;
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
