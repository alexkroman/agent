// Copyright 2026 the AAI authors. MIT license.
/**
 * One decision: does this runtime get a real `ctx.workflows`, and backed by what?
 *
 * Split from `runtime.ts` so `createRuntime` reads as one line, and from
 * `workflow-client.ts` so that module stays free of anything that resolves a
 * store at import time — which is what lets the client's own specs run with no
 * journal at all.
 *
 * The interesting part is the key store, because the two cases are not "prod and
 * a test" but two legitimate deployments:
 *
 * - **With a `DATABASE_URL`** — the correlation-key index is a table in the database
 *   the AUTHOR supplied. This used to be every platform workflow app, because
 *   creating one switched app storage on; the platform provisions no database now,
 *   so it is whoever set the secret.
 * - **Without** — the index is in memory and forgotten on restart.
 *
 * **The RUNS follow the same `DATABASE_URL`, and that is deliberate.** An
 * asymmetry here is a trap either way: durable runs beside a forgotten
 * correlation index means `find()` by key stops resolving across a restart while
 * the runs survive, and the reverse means a key pointing at a run that is gone.
 * One decision, one boot line, both reported.
 *
 * What is still missing is the PLATFORM journal: a deployed guest holds no
 * database of its own, so unless the author set a `DATABASE_URL` its runs are in
 * sandbox memory. That is the remaining half of the DevKit removal.
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
import { createInProcessWorkflowEngine } from "./workflow-in-process.ts";
import { createPostgresJournal } from "./workflow-journal-postgres.ts";
import { createRunNotifier, type RunNotifier } from "./workflow-notify.ts";

/**
 * The client a runtime hands to tools, and the handle its teardown owes.
 *
 * A PAIR rather than the client alone, because the engine's timers are not
 * reachable from a `WorkflowClient` and `aai dev` rebuilds its runtime on every
 * file save — so a discarded `stop` means each save leaves the previous engine
 * still executing bodies from a build that is gone. The runtime's
 * `releaseResources` already owns exactly this class of leak.
 */
export type BuiltWorkflowClient = {
  client: WorkflowClient;
  stop: () => void;
};

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
): BuiltWorkflowClient | undefined {
  const workflows = agent.workflows;
  if (!workflows || Object.keys(workflows).length === 0) return;
  logger.info?.("Workflows resolved", {
    workflows: Object.keys(workflows),
    // Which store is in play decides whether a correlation key survives a
    // restart, so it belongs in the one line an operator reads at boot rather
    // than being inferred from whether storage happens to be on.
    keyStore: db ? "postgres" : "memory",
    // The RUN store, which is a different question from the key store and the
    // one an operator actually asks after a restart. Reported rather than
    // assumed, because a durability tradeoff absent from the log reads as a bug —
    // and because there is now a case where the answer is good.
    runStore: db ? "postgres" : "memory (in-process — runs do not survive a restart)",
    // Reported at boot for the same reason the key store is: whether a run can
    // hand out a reachable callback URL is a property of the DEPLOYMENT, and the
    // alternative to one boot line is discovering it from a throw inside a tool
    // weeks later. The URL itself, not a boolean — a wrong origin is the other
    // half of the failure and a boolean cannot show it.
    publicUrl: publicUrl ?? "(unset — publicWebhookUrl will throw)",
  });
  // Held so `stop` can reach it: the CLIENT is what the runtime hands to tools,
  // and the engine's timers are what a rebuild has to cancel.
  const engine = createInProcessWorkflowEngine({
    workflows,
    logger,
    // A `DATABASE_URL` is what makes a run outlive its process. Absent, the
    // in-memory default stands and the boot line below says so — the honest trade
    // for trying a workflow out before provisioning anything.
    //
    // An explicit `undefined` rather than a conditional spread: `db` is an object
    // or absent, so the truthiness guard and a presence test agree, and
    // `guard-invariants` rule 22 is right that the spread hides which of the
    // three situations this is.
    journal: db ? createPostgresJournal({ db }) : undefined,
  });
  const client = createWorkflowClient({
    workflows,
    keys: resolveKeyStore(db),
    // The engine this repo owns, executing its own deliveries in this process.
    // It replaced `wdkAdapter()`, and the swap had to happen HERE rather than
    // later: `createWorkflowClient` hands `start` the DECLARED KEY, which the
    // DevKit cannot resolve to a body at all — so the two halves had stopped
    // agreeing about what identifies a workflow.
    wdk: engine,
    // Declared `string | undefined` rather than optional on the options type, so
    // the absent case passes straight through — no `omitUndefined`, and no
    // spread-ternary for rule 2 to catch.
    publicUrl,
    logger,
  });
  return { client, stop: () => engine.stop() };
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
