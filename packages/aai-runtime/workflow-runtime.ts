// Copyright 2026 the AAI authors. MIT license.
/**
 * One decision: does this runtime get a real `ctx.workflows`, and backed by what?
 *
 * Split from `runtime.ts` so `createRuntime` reads as one line, and from
 * `workflow-client.ts` so that module stays free of the Workflow DevKit import
 * (see `workflow-wdk.ts` for why that matters to its specs).
 *
 * The interesting part is the key store, because the two cases are not "prod and
 * a test" but two legitimate deployments:
 *
 * - **With `ctx.db`** — the correlation-key index is a table in the database the
 *   AUTHOR supplied. This used to be every platform workflow app, because creating
 *   one switched storage on; the platform provisions no database now, so it is
 *   whoever set a `DATABASE_URL` secret.
 * - **Without** — `aai dev` against the Local World, which keeps runs in
 *   `.workflow-data/` and needs no database; and a deployed app on the platform
 *   world, whose RUNS are durable on the platform's own database even though this
 *   index is not. The index is then in memory and forgotten on restart.
 *
 *   Worth stating plainly because it is a real gap rather than a symmetry: a
 *   deployed app with no `DATABASE_URL` has durable runs and a forgotten
 *   correlation index, so `find()` by key stops resolving across a restart while
 *   the runs themselves survive.
 *
 * A missing database is therefore NOT a reason to withhold the client. It was
 * tempting to make storage a hard requirement and have `ctx.workflows` reject
 * without it — but that breaks `aai dev` for every agent whose project has no
 * `DATABASE_URL`, which is the ordinary way to try a workflow out before
 * deploying it.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { Db } from "@alexkroman1/aai/internal";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "./runtime-config.ts";
import { createWorkflowClient, resolveKeyStore } from "./workflow-client.ts";
import { createRunNotifier, type RunNotifier } from "./workflow-notify.ts";
import { wdkAdapter } from "./workflow-wdk.ts";

/**
 * Build `ctx.workflows` for one runtime, or `undefined` when the agent declares
 * no workflows.
 *
 * `undefined` rather than a rejecting client, so the ONE place that decides what
 * an unavailable client says is the tool executor
 * (`WORKFLOWS_UNAVAILABLE_MESSAGE`). Two producers of that message would drift,
 * and this one has less context to write a good one with.
 *
 * @internal
 */
export function buildWorkflowClient(
  agent: Pick<AgentDef, "workflows">,
  db: Db | undefined,
  /**
   * This deployment's own public base URL, or undefined when nothing told it —
   * see `RuntimeOptions.publicUrl`. Only `publicWebhookUrl` reads it, and only
   * to throw when it is absent.
   */
  publicUrl: string | undefined,
  logger: Logger,
): WorkflowClient | undefined {
  const workflows = agent.workflows;
  if (!workflows || Object.keys(workflows).length === 0) return;
  logger.info?.("Workflows resolved", {
    workflows: Object.keys(workflows),
    // Which store is in play decides whether a correlation key survives a
    // restart, so it belongs in the one line an operator reads at boot rather
    // than being inferred from whether storage happens to be on.
    keyStore: db ? "postgres" : "memory",
    // Reported at boot for the same reason the key store is: whether a run can
    // hand out a reachable callback URL is a property of the DEPLOYMENT, and the
    // alternative to one boot line is discovering it from a throw inside a tool
    // weeks later. The URL itself, not a boolean — a wrong origin is the other
    // half of the failure and a boolean cannot show it.
    publicUrl: publicUrl ?? "(unset — publicWebhookUrl will throw)",
  });
  return createWorkflowClient({
    workflows,
    keys: resolveKeyStore(db),
    wdk: wdkAdapter(),
    // Declared `string | undefined` rather than optional on the options type, so
    // the absent case passes straight through — no `omitUndefined`, and no
    // spread-ternary for rule 2 to catch.
    publicUrl,
    logger,
  });
}

/**
 * Build the run notifier for one runtime, or `undefined` when there is no client
 * to watch runs with.
 *
 * Beside `buildWorkflowClient` because it is the same decision one step on —
 * "does this runtime have workflows" — and because `runtime.ts` should read as
 * one line per capability rather than as the wiring for each.
 *
 * The announcer is a CALLBACK rather than the session map itself: this module
 * has no business knowing how a session is found, and the map is the one thing
 * only `createRuntime`'s scope has.
 *
 * @internal
 */
export function buildRunNotifier(
  workflows: WorkflowClient | undefined,
  announce: (sessionId: string, instruction: string) => boolean,
  logger: Logger,
): RunNotifier | undefined {
  if (!workflows) return undefined;
  return createRunNotifier({ client: workflows, announcer: { announce }, logger });
}
