// Copyright 2026 the AAI authors. MIT license.
// "Workflows" — what durable work this project declares, and how its recent runs
// are doing.
//
// The card sits directly under "API", which names the workflow endpoint but says
// nothing about what is on it. A workflow run is the one thing in this product
// that OUTLIVES every surface the studio already shows: the Preview pane frames a
// page or a voice client, the transcript shows a conversation, and a run that was
// started an hour ago by a caller who has since hung up appears in neither. Its
// state lives in the agent's own journal, and until now the only way to read that
// was `curl`.
//
// **It reads the AGENT's API, not a studio route.** There is no studio endpoint in
// front of this and deliberately so: the platform already brokers
// `/:slug/workflows/*` for exactly this shape of caller (see "The workflow API is
// brokered too" in packages/aai-server/CLAUDE.md), the studio shares that origin
// by construction, so `connect-src 'self'` already permits it. A second route
// would be a second thing to keep in step with the journal's shape.
//
// **Reading it can BOOT the agent's sandbox**, because brokering does. That is
// accepted rather than overlooked: someone who opens Settings to ask what their
// workflows are doing is asking a question only the agent can answer, and the
// alternative — a card that shows nothing until you press a button — answers it
// less often than it costs. The refresh is manual for the same reason it is on the
// Database card: the numbers are as old as the last fetch, which is stale exactly
// when they matter, and a poll would hold a container open for a pane nobody is
// watching.

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";

/** Recent runs shown per workflow. Enough to see a pattern, short enough to scan. */
const RUNS_PER_WORKFLOW = 5;

/**
 * Deadline on each request, for the reason every other studio fetch carries one:
 * a browser fetch has none, and a hung request never settles, so no error path or
 * retry ever runs. Generous because the first read may be waiting out a container
 * boot, which is what brokering does.
 */
const WORKFLOW_READ_TIMEOUT_MS = 20_000;

/** One run, as `GET /workflows/runs` reports it (`WorkflowRunSnapshot`). */
type Run = {
  runId: string;
  workflow: string;
  status: "pending" | "running" | "sleeping" | "completed" | "failed" | "cancelled";
  stepsCompleted: number;
  key?: string;
  error?: string;
  wakeAt?: number;
};

type Declared = { name: string; description?: string };

/** A workflow and the runs read for it. */
type WorkflowRuns = { workflow: Declared; runs: Run[] };

type WorkflowsCardProps = {
  /** The project's PUBLISHED slug, absent until the first Publish. */
  deployedSlug?: string | undefined;
  /** The auto-deployed preview's slug — the fallback before a publish. */
  previewSlug?: string | undefined;
};

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(WORKFLOW_READ_TIMEOUT_MS) });
  if (!res.ok) {
    // The agent's own error body is the diagnostic — a 503 while a sandbox boots
    // reads very differently from a 404 for a slug that no longer exists.
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * The declared workflows, each with its recent runs.
 *
 * Runs are fetched WITHOUT a correlation key — the keyless read
 * (`WorkflowClient.recent`) exists for this caller. A console has no key to ask
 * about, and most runs carry none at all: only a voice agent's runs are keyed, by
 * `startTool`, so filtering by one here would show an empty list for every static
 * page in the product.
 */
async function loadWorkflows(origin: string, slug: string): Promise<WorkflowRuns[]> {
  const base = `${origin}/${slug}/workflows`;
  const { workflows } = await readJson<{ workflows?: Declared[] }>(base);
  const declared = workflows ?? [];
  // Concurrent: an agent declares a handful of workflows, and the expensive part
  // (the sandbox boot) has already been paid by the listing above.
  return await Promise.all(
    declared.map(async (workflow) => {
      const query = new URLSearchParams({
        workflow: workflow.name,
        limit: String(RUNS_PER_WORKFLOW),
      });
      const { runs } = await readJson<{ runs?: Run[] }>(`${base}/runs?${query.toString()}`);
      return { workflow, runs: runs ?? [] };
    }),
  );
}

/** Colour by outcome — a failed run has to be findable without reading every row. */
const STATUS_CLASS: Record<Run["status"], string> = {
  pending: "text-muted",
  running: "text-fg",
  sleeping: "text-muted",
  completed: "text-fg",
  failed: "text-err",
  cancelled: "text-subtle",
};

/**
 * What a run's status says, in words rather than in the wire's vocabulary.
 *
 * `sleeping` is the one worth translating: it is the state that makes these runs
 * durable rather than merely slow (the run is RELEASED, holding no container), and
 * a bare "sleeping" beside a `wakeAt` epoch reads as a stuck job.
 */
function statusText(run: Run): string {
  if (run.status !== "sleeping") return run.status;
  const seconds = Math.max(0, Math.round((run.wakeAt ?? 0) - Date.now()) / 1000);
  return seconds > 0 ? `sleeping, resumes in ${Math.round(seconds)}s` : "sleeping, due now";
}

export function WorkflowsCard({ deployedSlug, previewSlug }: WorkflowsCardProps) {
  // The studio and the agent surface are one origin by construction (see "One
  // public origin" in packages/aai-server/CLAUDE.md), so no round trip asks for it.
  const origin = window.location.origin;
  const slug = deployedSlug ?? previewSlug;

  const query = useQuery({
    queryKey: queryKeys.workflowRuns(slug),
    queryFn: () => loadWorkflows(origin, slug as string),
    enabled: slug !== undefined,
    // No polling — see the header. `staleTime: Infinity` is what makes the
    // Refresh button the only thing that re-reads, rather than every remount of
    // the pane paying a broker call.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (slug === undefined) {
    return (
      <Card title="Workflows" blurb={BLURB}>
        <p className="m-0 text-[13px] leading-5 text-muted">
          Publish this project, or make an edit to build a preview, to see its workflows.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Workflows" blurb={BLURB}>
      {deployedSlug === undefined && (
        <p className="m-0 text-[11px] text-muted">
          Showing the <strong>preview</strong> agent — it has its own journal, separate from
          production.
        </p>
      )}

      {query.isPending && (
        <p className="m-0 text-[13px] text-muted" role="status">
          Reading the journal…
        </p>
      )}

      {/* A failure here is usually the agent, not the studio: a 503 while its
          sandbox boots, or a 404 for a workflow API an agent that declares none
          does not serve. Quoted verbatim, because that text is the difference. */}
      {query.isError && (
        <p className="m-0 text-[13px] text-err">
          Could not read the workflows: {query.error.message}
        </p>
      )}

      {query.data?.length === 0 && (
        <p className="m-0 text-[13px] leading-5 text-muted">
          This project declares no workflows. A voice agent does not need any — they are for work
          that has to outlive the call that started it.
        </p>
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
                        {statusText(run)}
                      </span>
                      <span className="text-[11px] text-muted">
                        {run.stepsCompleted} step{run.stepsCompleted === 1 ? "" : "s"}
                      </span>
                      {/* The failure message, not just the status: "failed" alone
                          sends someone to the logs for something already in hand. */}
                      {run.status === "failed" && run.error !== undefined && (
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
