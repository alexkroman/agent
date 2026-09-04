// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai logs` — what the deployed agent has printed.
 *
 * The terminal half of the same read the studio's Logs pane makes
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

import { sleep } from "@alexkroman1/aai/internal";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { getServerInfo } from "./_agent.ts";
import { checkedResponse } from "./_api-client.ts";
import { type CommandResult, ok } from "./_output.ts";
import { type SlugTarget, slugRequestOn } from "./_slug-api.ts";
import { log } from "./_ui.ts";

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

function isLogsPage(value: unknown): value is LogsPage {
  return (
    isRecord(value) &&
    Array.isArray(value.lines) &&
    typeof value.cursor === "number" &&
    typeof value.running === "boolean"
  );
}

/** `HH:MM:SS.mmm`, local — the same shape the studio pane prints. */
export function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One rendered line: time, then the text. `stderr` is called out by name. */
export function formatLine(line: LogLine): string {
  const mark = line.stream === "stderr" ? " ERR" : "";
  return `${formatTime(line.at)}${mark}  ${line.text}`;
}

/**
 * One page, against a target resolved ONCE by the caller.
 *
 * `slugRequestOn` rather than `slugRequest`: under `--follow` this runs every
 * second for the life of the command, and the target is immutable — see that
 * function's doc for what re-resolving it cost.
 */
async function readPage(target: SlugTarget, after: number): Promise<LogsPage> {
  const data = await slugRequestOn(target, `/logs?after=${after}`, { action: "logs" });
  return checkedResponse(data, isLogsPage, `the logs route for ${target.slug}`);
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
): Promise<CommandResult<LogsData>> {
  const target = await getServerInfo(cwd, opts.server);
  const { slug } = target;
  const page = await readPage(target, -1);
  let cursor = page.cursor;
  let printed = printPage(page);

  if (!opts.follow) {
    if (printed === 0) {
      log.info(
        page.running
          ? `${slug} is running and has printed nothing yet.`
          : `${slug} isn't running. Start a session, or send it a request, and its output shows up here.`,
      );
    }
    log.info("Recent output only — an agent's log lives in its sandbox and goes when it does.");
    return ok({ slug, lines: printed, running: page.running });
  }

  log.info(`Following ${slug}. Ctrl-C to stop.`);
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
    const next = await readPage(target, cursor).catch(() => undefined);
    if (!next) continue;
    cursor = next.cursor;
    running = next.running;
    printed += printPage(next);
  }
  return ok({ slug, lines: printed, running });
}

/** Write a page's lines (and any gap) to the log. Returns how many lines. */
function printPage(page: LogsPage): number {
  if (page.dropped > 0) {
    // Reported rather than swallowed: a tail that silently skips is
    // indistinguishable from an agent that went quiet.
    log.warn(`… ${page.dropped} earlier line(s) dropped — the agent printed faster than this read`);
  }
  for (const line of page.lines) log.message(formatLine(line));
  return page.lines.length;
}
