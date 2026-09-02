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

import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowRunSnapshot, WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { createWorkflowApiClient, type WorkflowApi } from "@alexkroman1/aai/workflow-api";
import { getServerInfo } from "./_agent.ts";
import { readProjectConfig } from "./_config.ts";
import { CliError, type CommandResult, fail, ok } from "./_output.ts";
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
 * What every verb here needs: a client aimed at the agent, and what to CALL it
 * in a printed line.
 *
 * `name`, not `slug`: `--agent` targets a server that has no slug, and the
 * origin is what identifies it. The only reader is `list`'s "<x> declares no
 * workflows".
 */
type Target = { api: WorkflowApi; name: string };

type WorkflowOptions = {
  server?: string | undefined;
  token?: string | undefined;
  agent?: string | undefined;
};

/**
 * The base URL {@link createWorkflowApiClient} is given for `--agent`.
 *
 * A dev server has no slug: `createServer` mounts the workflow API at
 * `WORKFLOW_API_PREFIX` on the ORIGIN, where the platform serves it under
 * `/:slug`. So targeting one is not a matter of a different origin — it is the
 * absence of the path segment, which nothing in this command could express.
 *
 * Validated rather than interpolated. This value is joined into a request path,
 * and the CLI's standing rule is that anything reaching a URL is checked at the
 * one point it becomes a target (`resolveDeployTarget`'s slug guard is the same
 * rule). It is also the only origin here that `resolveServerUrl` does not
 * produce, so stripping the trailing slash is this function's job — the join
 * site deliberately carries no copy of that.
 *
 * No trust check, deliberately, and the asymmetry with `--server` is the point:
 * `--server` pairs an origin with the user's PLATFORM API KEY, which is why a
 * repo-supplied loopback URL is refused there. Nothing credentialed goes to
 * `--agent` — the workflow API takes the agent's own bearer or none — so there
 * is nothing for a hostile origin to collect, and requiring `aai login` to read
 * runs off a server on your own laptop is the defect this flag exists for.
 */
function agentBaseUrl(raw: string): string {
  // `URL.parse` rather than `new URL` in a try: a malformed value is an ANSWER
  // here, and the constructor's `TypeError` carries nothing the caller did not
  // already type — so there is no cause worth threading and no catch to write.
  const url = URL.parse(raw);
  if (url === null) {
    throw new CliError("bad_agent_url", `--agent is not a URL: ${JSON.stringify(raw)}`, HINT_URL);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(
      "bad_agent_url",
      `--agent must be http or https, not ${url.protocol.replace(":", "")}`,
      HINT_URL,
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * A client for the agent's workflow API, plus the bearer when one was given.
 *
 * Two ways in. `--agent <url>` names a server the caller is running themselves
 * — `aai dev`, or the scaffold's `npm start` — and takes that URL as the base:
 * no project config, no published slug, and no `ensureApiKey`, none of which
 * such a server has or wants. Otherwise `getServerInfo` turns "this directory"
 * into a platform origin and a published slug.
 *
 * The client is handed the AGENT's base URL and appends the route prefix itself,
 * so the `/workflows` literal is not spelled here — it is the same constant the
 * server matches on.
 *
 * `serverUrl` is joined as-is: `resolveServerUrl` is the single producer of
 * every origin that reaches THAT branch and strips trailing slashes once, at
 * resolution time, precisely so join sites do not each carry a copy. The copy
 * this used to hold also DISAGREED with it — `/\/$/` takes one slash where the
 * upstream `/\/+$/` takes all — so the two would have differed on the only
 * input either was written for.
 *
 * **The no-deployment failure is raised HERE rather than by
 * `requireDeployedSlug`, and the ordering is why.** `getServerInfo` resolves the
 * API key BEFORE it looks for a slug, so in an undeployed project the first
 * thing a developer running `aai dev` saw was `not_logged_in` — pointing at
 * `aai login` for a command that never sends the key it was asking for, with
 * the real cause two errors away. Reading the project config first puts the
 * cause first and lets the sentence name every way out: publish it, or point at
 * the server already running.
 */
async function target(cwd: string, opts: WorkflowOptions): Promise<Target> {
  if (opts.agent !== undefined) {
    const baseUrl = agentBaseUrl(opts.agent);
    return {
      api: createWorkflowApiClient({ baseUrl, ...omitUndefined({ token: opts.token }) }),
      name: baseUrl,
    };
  }
  const config = await readProjectConfig(cwd);
  if (!config?.slug) throw new CliError("no_deployment", NO_DEPLOYMENT, HINT_AGENT);
  const { serverUrl, slug } = await getServerInfo(cwd, opts.server);
  return {
    api: createWorkflowApiClient({
      baseUrl: `${serverUrl}/${slug}`,
      ...omitUndefined({ token: opts.token }),
    }),
    name: slug,
  };
}

/**
 * What a project with no deployment is told, and why it names two ways out.
 *
 * `requireDeployedSlug`'s sentence — "run `aai publish` first" — is right for
 * `aai secret` and `aai delete`, which have nothing to talk to until the agent
 * is on the platform. It is wrong here often enough to be a defect: a workflow
 * API is the one agent surface that is fully live under `aai dev`, so the
 * developer being told to publish frequently has the thing they asked about
 * answering on localhost already.
 */
const NO_DEPLOYMENT =
  "This project has no deployed agent, and no --agent URL was given — so there is " +
  "nothing for `aai workflow` to ask.";

/**
 * What a malformed `--agent` is told.
 *
 * Its own hint rather than {@link HINT_AGENT}: the caller already knows about
 * the flag — they typed it — so repeating "run `aai publish`" answers a
 * question they did not ask.
 */
const HINT_URL = "Pass a full origin, e.g. --agent http://localhost:3000";

/** How to reach a server you are running yourself. Paired with {@link NO_DEPLOYMENT}. */
const HINT_AGENT =
  "Run `aai publish` to deploy it, or pass --agent <url> to target a server you are " +
  "already running — `--agent http://localhost:3000` for `aai dev`, which needs no " +
  "login and no slug.";

/** The failure arm of a {@link CommandResult}, which every verb here may return. */
type Failure = Extract<CommandResult<never>, { ok: false }>;

/**
 * Run one call, turning a rejection into this command's failure result.
 *
 * The client throws with the AGENT'S own sentence — an unknown workflow names
 * the declared ones, a 503 says the sandbox is still booting — and that text is
 * the whole diagnostic, so it is surfaced rather than replaced with a status
 * code. `errorMessage` rather than `instanceof Error`, because a rejection that
 * is message-bearing without being an `Error` would otherwise print as
 * `[object Object]`.
 *
 * It builds the failure result itself rather than handing the caller an error
 * string: all four verbs paired it with the same `HINT_BROKER` and the same
 * `workflow_*_failed` shape, so the hint was spelled four times and a fifth
 * verb could quietly omit it. The caller supplies only the code and forwards
 * the result — `if (!res.ok) return res;`.
 */
async function attempt<T>(
  code: string,
  call: () => Promise<T>,
): Promise<{ ok: true; value: T } | Failure> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    return { ok: false, code, error: errorMessage(err), hint: HINT_BROKER };
  }
}

/** `aai workflow list` — what this agent declares. */
export async function executeWorkflowList(
  cwd: string,
  opts: WorkflowOptions,
): Promise<CommandResult<{ workflows: WorkflowSummary[] }>> {
  const { api, name } = await target(cwd, opts);
  const res = await attempt("workflow_list_failed", () => api.list());
  if (!res.ok) return res;
  const workflows = res.value;
  if (workflows.length === 0) {
    log.info(`${name} declares no workflows`);
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
  const res = await attempt("workflow_runs_failed", () =>
    api.recent(workflow, { limit: opts.limit ?? DEFAULT_RUN_LIMIT }),
  );
  if (!res.ok) return res;
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
  const res = await attempt("workflow_show_failed", () => api.get(runId));
  if (!res.ok) return res;
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
  const res = await attempt("workflow_cancel_failed", () => api.cancel(runId));
  if (!res.ok) return res;
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
