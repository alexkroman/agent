// Copyright 2026 the AAI authors. MIT license.
// "Workflows" — what durable work this project declares, and how its recent
// runs are doing.
//
// A workflow run is the one thing in this product that OUTLIVES every surface
// the studio already shows: the Preview pane frames a page or a voice client,
// the transcript shows a conversation, and a run started an hour ago by a
// caller who has since hung up appears in neither. Its state lives with the
// agent, and without this card the only way to read it is `aai workflow runs`
// or a hand-built `curl`.
//
// **It reads the AGENT's API, not a studio route.** There is no studio endpoint
// in front of this and deliberately so: the platform already brokers
// `/:slug/workflows/*` for exactly this shape of caller, the studio shares that
// origin by construction (see "One public origin" in
// packages/aai-server/CLAUDE.md), so `connect-src 'self'` already permits it. A
// second route would be a second thing to keep in step with the run shape.
//
// **Reading it can BOOT the agent's sandbox**, because brokering does. That is
// accepted rather than overlooked: someone who opens Settings to ask what their
// workflows are doing is asking a question only the agent can answer, and the
// alternative — a card that shows nothing until you press a button — answers it
// less often than it costs. The refresh is manual, and the reason is the one the
// deleted Database card made first: the numbers are as old as the last fetch,
// which is stale exactly when they matter, and a poll would hold a container open
// for a pane nobody is watching.

import {
  createWorkflowApiClient,
  isTerminal,
  type WorkflowApi,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowSummary,
} from "@alexkroman1/aai/workflow-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_READ_TIMEOUT_MS } from "./api-timeouts.ts";
import { agentBase, NO_WORKFLOWS_DECLARED, workflowReadFailure } from "./docs-content.ts";
import { platformOrigin } from "./platform-origin.ts";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";

/** Recent runs shown per workflow. Enough to see a pattern, short enough to scan. */
const RUNS_PER_WORKFLOW = 5;

/**
 * One run, as `GET /workflows/runs` reports it — the SDK's own type, not a
 * restatement.
 *
 * There is no boundary in the way: this package already depends on
 * `@alexkroman1/aai` and imports from it (`cli-link.ts`). The copy that used to
 * sit here flattened a DISCRIMINATED union into optional fields, so `error` was
 * `string | undefined` on every status and the row below had to re-assert by
 * hand what narrowing on `status` already proves — and a field added to the
 * snapshot would have stopped reaching this card silently, which is the same
 * argument `aai workflow` makes for using the type directly.
 */
type Run = WorkflowRunSnapshot;

/** A declared workflow, as `GET /workflows` lists it. */
type Declared = WorkflowSummary;

/** A workflow and the runs read for it. */
type WorkflowRuns = { workflow: Declared; runs: Run[] };

type WorkflowsCardProps = {
  /** The project's PUBLISHED slug, absent until the first Publish. */
  deployedSlug?: string | undefined;
  /** The auto-deployed preview's slug — the fallback before a publish. */
  previewSlug?: string | undefined;
};

/**
 * A client for one agent's workflow API.
 *
 * The SDK's (`@alexkroman1/aai/workflow-api`), not a third hand-written copy of
 * the same three fetches — this card, the browser client and `aai workflow` had
 * each written their own subset, and the parts they disagreed on (whether a
 * `{ runs }` body that arrived without the field reads as empty, whether the
 * agent's `{ error }` sentence is unwrapped or quoted still wrapped in its JSON —
 * this one did the latter for a while) were the parts nobody could check by eye.
 *
 * `timeoutMs` is what this caller needs on top: the deadline every studio fetch
 * carries, because a browser fetch has none and a hung request never settles, so
 * no error path or retry ever runs. It is generous because the first read may be
 * waiting out a container boot, which is what brokering does.
 */
function clientFor(origin: string, slug: string): WorkflowApi {
  return createWorkflowApiClient({
    baseUrl: agentBase(origin, slug),
    timeoutMs: AGENT_READ_TIMEOUT_MS,
  });
}

/**
 * The declared workflows, each with its recent runs.
 *
 * Runs are fetched WITHOUT a correlation key — the keyless read
 * (`WorkflowClient.recent`) exists for this caller. A console has no key to ask
 * about, and most runs carry none at all: only a voice agent's runs are keyed,
 * by the tool that started them, so filtering by one here would show an empty
 * list for every workflow app in the product.
 */
async function loadWorkflows(origin: string, slug: string): Promise<WorkflowRuns[]> {
  const api = clientFor(origin, slug);
  const declared: Declared[] = await api.list();
  // Concurrent: an agent declares a handful of workflows, and the expensive part
  // (the sandbox boot) has already been paid by the listing above.
  return await Promise.all(
    declared.map(async (workflow) => {
      const runs: Run[] = await api.recent(workflow.name, { limit: RUNS_PER_WORKFLOW });
      return { workflow, runs };
    }),
  );
}

/**
 * Stop a live run.
 *
 * The route answers 200 with `cancelled: false` rather than failing when the
 * run had already finished, so two operators clicking is ordinary. The boolean
 * the client resolves is not surfaced: what the operator wants to see is the
 * run's new state, which the refetch below provides.
 */
async function cancelRun(origin: string, slug: string, runId: string): Promise<void> {
  await clientFor(origin, slug).cancel(runId);
}

/** Colour by outcome — a failed run has to be findable without reading every row. */
const STATUS_CLASS: Record<WorkflowRunStatus, string> = {
  pending: "text-muted",
  running: "text-fg",
  completed: "text-fg",
  failed: "text-err",
  cancelled: "text-subtle",
};

/**
 * Can this run still change on its own? Only a live run is stoppable.
 *
 * The negation of the SDK's `isTerminal` rather than a second list of the live
 * statuses: the two would have to be kept complementary by hand, and a status
 * added to the union is exactly the case where a hand-written list quietly
 * decides the wrong way.
 */
function isLive(run: Run): boolean {
  return !isTerminal(run);
}

/**
 * When the run started, as a local time.
 *
 * A run list with no clock in it is unreadable the moment there is more than
 * one: `createdAt` is the only ordering the wire carries, and "newest first"
 * says nothing about whether the newest is from a minute ago or last week.
 */
function startedAt(run: Run): string {
  return new Date(run.createdAt).toLocaleString();
}

export function WorkflowsCard({ deployedSlug, previewSlug }: WorkflowsCardProps) {
  const slug = deployedSlug ?? previewSlug;
  if (slug === undefined) {
    return (
      <Card title="Workflows" blurb={BLURB}>
        <p className="m-0 text-[13px] leading-5 text-muted">
          Publish this project, or make an edit to build a preview, to see its workflows.
        </p>
      </Card>
    );
  }
  return <AgentWorkflows slug={slug} deployedSlug={deployedSlug} />;
}

/**
 * The card once there IS a slug to read.
 *
 * Its own component so `slug` is a required `string`. Held in one component it
 * had to be `string | undefined`, and the query and the cancel both narrowed it
 * with `slug as string` — a cast asserting the `enabled:` flag two lines above,
 * which is the sort of agreement nothing checks and a later edit can break
 * without a squiggle.
 */
function AgentWorkflows({
  slug,
  deployedSlug,
}: {
  slug: string;
  deployedSlug?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const origin = platformOrigin();

  const query = useQuery({
    queryKey: queryKeys.workflowRuns(slug),
    queryFn: () => loadWorkflows(origin, slug),
    // No polling — see the header. `staleTime: Infinity` is what makes the
    // Refresh button the only thing that re-reads, rather than every remount of
    // the pane paying a broker call.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const stop = useMutation({
    mutationFn: (runId: string) => cancelRun(origin, slug, runId),
    // Re-read rather than patching the row: the run's new state is the agent's
    // to report, and a cancel races whatever the run was doing.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.workflowRuns(slug) }),
  });

  return (
    <Card title="Workflows" blurb={BLURB}>
      {deployedSlug === undefined && (
        <p className="m-0 text-[11px] text-muted">
          Showing the <strong>preview</strong> agent — it has its own runs, separate from
          production.
        </p>
      )}

      {query.isPending && (
        <p className="m-0 text-[13px] text-muted" role="status">
          Reading recent runs…
        </p>
      )}

      {query.isError && (
        <p className="m-0 text-[13px] text-err">{workflowReadFailure(query.error.message)}</p>
      )}

      {query.data?.length === 0 && (
        <p className="m-0 text-[13px] leading-5 text-muted">{NO_WORKFLOWS_DECLARED}</p>
      )}

      {query.data && query.data.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-5 p-0">
          {query.data.map(({ workflow, runs }) => (
            <li key={workflow.name} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[13px] font-medium text-fg">{workflow.name}</span>
                {workflow.description !== undefined && (
                  <span className="text-[11px] text-subtle">{workflow.description}</span>
                )}
              </div>
              {runs.length === 0 ? (
                <p className="m-0 text-[11px] text-muted">No runs yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {runs.map((run) => (
                    <li
                      key={run.runId}
                      className="flex flex-wrap items-baseline gap-x-3 rounded-md border border-line bg-cream px-3 py-2"
                    >
                      <code className="font-mono text-[11px] text-subtle">
                        {run.runId.slice(0, 8)}
                      </code>
                      <span className={`text-[12px] ${STATUS_CLASS[run.status]}`}>
                        {run.status}
                      </span>
                      <span className="text-[11px] text-muted">{startedAt(run)}</span>
                      {run.key !== undefined && (
                        <span className="font-mono text-[11px] text-subtle">key={run.key}</span>
                      )}
                      {/* Only a live run has anything to press. A terminal one is
                          deliberately a dead end here: resuming it is the
                          Workflow DevKit's business, not a button that would
                          have to guess what "again" means. */}
                      {isLive(run) && (
                        <button
                          type="button"
                          className="btn ml-auto shrink-0 px-2 py-0.5 text-[11px]"
                          disabled={stop.isPending}
                          onClick={() => stop.mutate(run.runId)}
                          aria-label={`Stop run ${run.runId}`}
                        >
                          Stop
                        </button>
                      )}
                      {/* The failure message, not just the status: "failed"
                          alone sends someone to the logs for something already
                          in hand. No presence check — narrowing to `"failed"`
                          makes `error` non-optional, which is what the
                          discriminated union is for. */}
                      {run.status === "failed" && (
                        <span className="min-w-0 basis-full text-[11px] break-words text-err">
                          {run.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {stop.isError && (
        <p className="m-0 text-[13px] text-err">Could not stop the run: {stop.error.message}</p>
      )}

      <button
        type="button"
        className="btn self-start px-2 py-1 text-xs"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
      >
        {query.isFetching ? "Reading…" : "Refresh runs"}
      </button>
    </Card>
  );
}

const BLURB =
  "Durable work this project declares, and how its recent runs are doing. A run outlives the " +
  "session that started it, so this is the only place its state shows up — reading it may wake " +
  "the agent's sandbox.";
