// Copyright 2026 the AAI authors. MIT license.
/**
 * What the coding agent's `read_logs` tool actually reads: the project's own
 * deployed agent, through the platform's owner-authenticated `GET /:slug/logs`.
 *
 * The gap it closes is the one the Logs pane closed for the HUMAN. A studio
 * agent's runtime failure — a tool that throws on a live call, a provider key
 * that is missing, a `console.error` the code prints on the path nobody tested
 * — is visible in the pane and nowhere the coding agent can reach. Its only
 * runtime evidence was `test_agent`, which loads the bundle in the SANDBOX and
 * therefore cannot see anything the deployed agent did with a real caller on
 * the line.
 *
 * ## The guest never names a slug
 *
 * The RPC carries an ENVIRONMENT (`preview` | `production`) and this resolves
 * it against the workspace of the (scope, project) the sandbox is pinned to —
 * the same `projectSlugFor` pair every other project surface resolves. A guest
 * that could pass a slug could read any agent whose slug it guessed, and the
 * bearer it would be read with is the account's own key, so the ownership check
 * on the far end would not stop it. Nothing about the read is model-controlled
 * except how many lines come back.
 *
 * ## Why HTTP to our own origin
 *
 * `readAgentLogs` (aai-server/agent-logs.ts) is right there in the same
 * process, and calling it directly would need the slot cache and the fleet-wide
 * sandbox directory threaded through the studio app, the routes, and the
 * broker — three layers that have no other reason to know what a sandbox slot
 * is. The public route already owns the lookup, the peer fallback, and the
 * ownership check; `warmPreviewSandbox` reaches the platform's own origin the
 * same way for the same reason.
 *
 * ## The tail, not the head
 *
 * The guest's ring is cursor-indexed and a read returns the OLDEST lines after
 * the cursor, which is exactly backwards for "why did it just break". So this
 * drains forward by cursor, bounded, and hands back the LAST `limit` lines with
 * a count of what it dropped on the floor. The ring holds 2,000 lines and one
 * page is 500, so a full drain is four requests against an in-memory slice.
 *
 * @module
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { WorkspaceStore } from "aai-server/stores";
import { type ProjectEnvironment, projectSlugFor } from "./studio-project-slugs.ts";
import { getWorkspace } from "./studio-workspace.ts";

/** One captured line, as the platform reports it. */
export type AgentLogLine = {
  seq: number;
  at: number;
  stream: "stdout" | "stderr";
  text: string;
};

/** What one `read_logs` call gets back. */
export type ProjectLogsResult = {
  /** The agent read, absent when the environment has never been deployed. */
  slug?: string;
  /** Whether a sandbox is up. An empty page means different things either way. */
  running: boolean;
  lines: AgentLogLine[];
  /** Lines the ring evicted before this read reached them. */
  dropped: number;
  /** Total lines held after the drain, before the tail was taken. */
  total: number;
};

/** Lines one call may ask for. The ring itself holds 2,000. */
export const MAX_LOG_TOOL_LINES = 500;
export const DEFAULT_LOG_TOOL_LINES = 100;

/**
 * Pages one drain may read.
 *
 * Five covers the whole 2,000-line ring at the platform's 500-line page, with
 * one to spare. It is a bound on THIS side rather than a trust in the far
 * side's: a route that answered with a cursor that advances by one line forever
 * would otherwise hold an RPC open until the guest's own deadline.
 */
const MAX_PAGES = 5;

/** How long one page read may take before it is abandoned. */
const LOGS_REQUEST_TIMEOUT_MS = 10_000;

export type ProjectLogsDeps = {
  workspaces: WorkspaceStore;
  scope: string;
  project: string;
  /** Public platform origin plus the account key the agents were deployed with. */
  target: { serverUrl: string; apiKey: string };
  fetchFn?: typeof globalThis.fetch | undefined;
};

export type ProjectLogsOpts = {
  environment?: ProjectEnvironment;
  limit?: number;
};

/** The wire shape of the platform's `GET /:slug/logs`, checked field by field. */
function parsePage(
  body: unknown,
): { lines: AgentLogLine[]; cursor: number; dropped: number; running: boolean } | null {
  if (!(isRecord(body) && Array.isArray(body.lines) && typeof body.cursor === "number")) {
    return null;
  }
  return {
    lines: body.lines.filter(isLogLine),
    cursor: body.cursor,
    dropped: typeof body.dropped === "number" && body.dropped > 0 ? body.dropped : 0,
    running: body.running === true,
  };
}

function isLogLine(value: unknown): value is AgentLogLine {
  return (
    isRecord(value) &&
    typeof value.seq === "number" &&
    typeof value.at === "number" &&
    typeof value.text === "string" &&
    (value.stream === "stdout" || value.stream === "stderr")
  );
}

/**
 * Read one of the project's two agents' buffered output.
 *
 * Throws only for the states the agent can ACT on — an environment that has
 * never deployed, a platform that refused the read — because a tool result the
 * model reads as prose is the caller here, and "no logs" and "you are not
 * allowed to read these" call for different next moves. A transport failure
 * mid-drain keeps what it already has: half a log answers the question more
 * often than an error does.
 */
export async function readProjectLogs(
  deps: ProjectLogsDeps,
  opts: ProjectLogsOpts = {},
): Promise<ProjectLogsResult> {
  const environment = opts.environment ?? "preview";
  const workspace = await getWorkspace(deps.workspaces, deps.scope, deps.project);
  if (!workspace) throw new Error(`Project ${deps.project} not found`);
  const slug = projectSlugFor(workspace, environment);
  if (!slug) return { running: false, lines: [], dropped: 0, total: 0 };

  const limit = Math.min(
    Math.max(Math.floor(opts.limit ?? DEFAULT_LOG_TOOL_LINES), 1),
    MAX_LOG_TOOL_LINES,
  );
  const drained = await drainRing(slug, deps);
  return { slug, ...drained, lines: drained.lines.slice(-limit), total: drained.lines.length };
}

/** One page read. `null` is "stop draining"; a first-page refusal throws. */
async function readOnePage(
  slug: string,
  deps: ProjectLogsDeps,
  after: number,
  first: boolean,
): Promise<ReturnType<typeof parsePage>> {
  const url = new URL(`/${encodeURIComponent(slug)}/logs`, deps.target.serverUrl);
  url.searchParams.set("after", String(after));
  const res = await (deps.fetchFn ?? fetch)(url, {
    headers: { authorization: `Bearer ${deps.target.apiKey}` },
    signal: AbortSignal.timeout(LOGS_REQUEST_TIMEOUT_MS),
  });
  if (res.ok) return parsePage(await res.json());
  // A refusal on the FIRST page is the whole answer and has to be said out
  // loud; one mid-drain is a page of a log the caller already partly holds.
  if (first) throw new Error(`Log read for ${slug} failed with ${res.status}`);
  return null;
}

/** Walk the ring forward by cursor, bounded, and keep everything it yields. */
async function drainRing(
  slug: string,
  deps: ProjectLogsDeps,
): Promise<{ running: boolean; lines: AgentLogLine[]; dropped: number }> {
  const lines: AgentLogLine[] = [];
  let cursor = -1;
  let dropped = 0;
  let running = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const parsed = await readOnePage(slug, deps, cursor, page === 0);
    if (!parsed) break;
    running = parsed.running;
    dropped += parsed.dropped;
    lines.push(...parsed.lines);
    // A page that returned nothing, or a cursor that did not move, is the end
    // of the ring — the second condition being the one that stops a far side
    // answering with a stuck cursor from spinning out the whole page budget.
    if (parsed.lines.length === 0 || parsed.cursor <= cursor) break;
    cursor = parsed.cursor;
  }
  return { running, lines, dropped };
}
