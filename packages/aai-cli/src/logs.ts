// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai logs` — what the deployed agent has printed.
 *
 * The terminal half of the same read the studio's coding agent makes
 * (`GET /:slug/logs`, aai-server/agent-logs.ts): a bounded ring the GUEST holds,
 * paged by cursor. Two things follow from that and are what this command has to
 * be honest about, because neither is visible in a wall of lines:
 *
 * - **The ring dies with the sandbox.** This is "what my agent printed
 *   recently", never "what it printed last Tuesday", and the footer says so on
 *   a one-shot read rather than leaving the absence to be inferred.
 * - **`running` is not `lines.length`.** An agent that is up and quiet and one
 *   that is not up at all both print nothing, and they want opposite things
 *   from the reader. The one-shot read reports which it was.
 *
 * `--follow` polls. A stream would be the nicer shape and the source is not one:
 * the guest holds a RING with a cursor, and a reconnecting stream would have to
 * re-derive that cursor anyway.
 */

import { formatLogTime } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { checkedResponse } from "./_api-client.ts";
import { type CommandResult, ok } from "./_output.ts";
import { type PlatformDeps, REAL_PLATFORM, type SlugTarget, slugRequestOn } from "./_slug-api.ts";
import { defaultUi, type Ui } from "./_ui.ts";

/** One captured line, as the platform reports it. */
export type LogLine = {
  seq: number;
  at: number;
  stream: "stdout" | "stderr";
  text: string;
};

/** One read of the ring. Mirrors `AgentLogsResponse` on the platform. */
export type LogsPage = {
  lines: LogLine[];
  cursor: number;
  dropped: number;
  running: boolean;
};

/** How often `--follow` asks for what is new. */
export const FOLLOW_POLL_MS = 1000;

export type LogsOpts = {
  server?: string | undefined;
  /** Keep polling until interrupted. */
  follow?: boolean | undefined;
  /** Poll cadence override, for tests. */
  pollMs?: number | undefined;
  /** Stops a `--follow` loop. Tests pass one; the CLI leaves it to Ctrl-C. */
  signal?: AbortSignal | undefined;
};

/**
 * The page's envelope. `lines` is only checked to BE an array here: one bad
 * entry must not cost the good ones (see {@link checkedLines}).
 */
function isLogsPage(
  value: unknown,
): value is Omit<LogsPage, "lines" | "dropped"> & { lines: unknown[]; dropped?: number } {
  return (
    isRecord(value) &&
    Array.isArray(value.lines) &&
    Number.isFinite(value.cursor) &&
    (value.dropped === undefined || Number.isFinite(value.dropped)) &&
    typeof value.running === "boolean"
  );
}

/** `at` is not required: a line with a bad time still has text worth showing. */
function isLogLine(value: unknown): value is Omit<LogLine, "at"> & { at: unknown } {
  return (
    isRecord(value) &&
    Number.isFinite(value.seq) &&
    (value.stream === "stdout" || value.stream === "stderr") &&
    typeof value.text === "string"
  );
}

/** A page's well-formed lines, and how many were not. */
type CheckedPage = LogsPage & { malformed: number };

/**
 * The lines that are lines. Under `--follow` one `null` entry threw
 * `Cannot read properties of null` OUTSIDE the poll's catch and ended the
 * command, so entries are checked one by one and the bad ones counted.
 */
function checkedLines(lines: unknown[]): { lines: LogLine[]; malformed: number } {
  const good = lines
    .filter(isLogLine)
    .map((l) => ({ ...l, at: typeof l.at === "number" ? l.at : Number.NaN }));
  return { lines: good, malformed: lines.length - good.length };
}

/**
 * One rendered line: time, then the text. `stderr` is called out by name. A
 * timestamp that is not a time renders as dashes, not `NaN:NaN:NaN.NaN`.
 */
export function formatLine(line: LogLine): string {
  const mark = line.stream === "stderr" ? " ERR" : "";
  const time = Number.isFinite(line.at) ? formatLogTime(line.at) : "--:--:--.---";
  return `${time}${mark}  ${line.text}`;
}

/**
 * One page, against a target resolved ONCE by the caller.
 *
 * `slugRequestOn` rather than `slugRequest`: under `--follow` this runs every
 * second for the life of the command, and the target is immutable — see that
 * function's doc for what re-resolving it cost.
 */
async function readPage(
  target: SlugTarget,
  after: number,
  platform: PlatformDeps,
): Promise<CheckedPage> {
  const data = await slugRequestOn(target, `/logs?after=${after}`, { action: "logs" }, platform);
  const page = checkedResponse(data, isLogsPage, `the logs route for ${target.slug}`);
  return { ...page, dropped: page.dropped ?? 0, ...checkedLines(page.lines) };
}

type LogsData = { slug: string; lines: number; running: boolean };

/**
 * Print the agent's buffered output, once or continuously.
 *
 * The `--json` shape reports the LINE COUNT rather than the lines: a follow
 * loop has no final count to report, and a one-shot read that dumped every line
 * into a result object would duplicate what it just printed.
 */
export async function executeLogs(
  cwd: string,
  opts: LogsOpts = {},
  ui: Ui = defaultUi,
  platform: PlatformDeps = REAL_PLATFORM,
): Promise<CommandResult<LogsData>> {
  const target = await platform.getServerInfo(cwd, opts.server);
  const { slug } = target;
  const page = await readPage(target, -1, platform);
  let cursor = page.cursor;
  const seen = { lastSeq: Number.NEGATIVE_INFINITY };
  let printed = printPage(page, ui, seen);

  if (!opts.follow) {
    if (printed === 0) {
      ui.log.info(
        page.running
          ? `${slug} is running and has printed nothing yet.`
          : `${slug} isn't running. Start a session, or send it a request, and its output shows up here.`,
      );
    }
    ui.log.info("Recent output only — an agent's log lives in its sandbox and goes when it does.");
    return ok({ slug, lines: printed, running: page.running });
  }

  ui.log.info(`Following ${slug}. Ctrl-C to stop.`);
  const pollMs = opts.pollMs ?? FOLLOW_POLL_MS;
  let running = page.running;
  while (!opts.signal?.aborted) {
    // `sleep` from the SDK, never `node:timers/promises` — `guard-invariants`
    // rule 19. An abort RESOLVES it rather than rejecting, so the loop's own
    // check below is what ends the follow. `omitUndefined` rather than a
    // truthiness-guarded spread (rule 22): `SleepOptions.signal` is optional
    // under `exactOptionalPropertyTypes`, so the guard IS the presence test.
    await sleep(pollMs, omitUndefined({ signal: opts.signal }));
    if (opts.signal?.aborted) break;
    // A failed poll is not a failed command: an agent between sandboxes answers
    // exactly like a network blip, and the next tick is a second away. Only a
    // signalled stop ends the loop.
    // Every check of the page is inside `readPage`, so inside this catch —
    // a malformed entry once threw from the print below and ended the follow.
    const next = await readPage(target, cursor, platform).catch(() => undefined);
    if (!next) continue;
    // A cursor that went BACKWARDS is a fresh ring (a new sandbox numbers
    // from zero again), so its lines are new even at seqs already printed.
    if (next.cursor < cursor) seen.lastSeq = Number.NEGATIVE_INFINITY;
    cursor = next.cursor;
    running = next.running;
    printed += printPage(next, ui, seen);
  }
  return ok({ slug, lines: printed, running });
}

/**
 * Write a page's NEW lines (and any gap) to the log. Returns how many lines.
 *
 * `seen.lastSeq` dedupes: a server whose cursor does not advance answers the
 * same page every second, and printed it every second.
 */
function printPage(page: CheckedPage, ui: Ui, seen: { lastSeq: number }): number {
  if (page.dropped > 0) {
    // Reported rather than swallowed: a tail that silently skips is
    // indistinguishable from an agent that went quiet.
    ui.log.warn(
      `… ${page.dropped} earlier line(s) dropped — the agent printed faster than this read`,
    );
  }
  if (page.malformed > 0) {
    ui.log.warn(`… ${page.malformed} malformed line(s) in the server's answer skipped`);
  }
  let count = 0;
  for (const line of page.lines) {
    if (line.seq <= seen.lastSeq) continue;
    seen.lastSeq = line.seq;
    ui.log.message(formatLine(line));
    count++;
  }
  return count;
}
