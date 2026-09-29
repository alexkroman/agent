// Copyright 2026 the AAI authors. MIT license.
/**
 * A failing try, as something a reader can act on: every line said, every
 * reply, every tool call with its arguments and result — bounded.
 *
 * The `AAI_EVAL_REPEAT` summary is where an UNSTABLE case is reported, and a
 * case that passed overall prints nothing else: vitest shows no failure for
 * it, so the summary line is the only trace the failing try leaves. It used to
 * print the first LINE of the failure message, which for most live failures is
 * `expected 'Sure — one moment.' to match /booked/i` and nothing about what the
 * agent was doing when it said it. Two downstream suites wrapped every case to
 * append their own transcript to the error and put it LAST, because only the
 * first line survived. This is that transcript, built once from the session's
 * own event stream.
 *
 * Bounded on purpose, per field and in total: a live model that pasted a
 * document into a tool argument, or a fixture that returned a page, must not
 * turn one unstable case into a screen of JSON that buries the others.
 *
 * @module
 */

import type { SessionEvent } from "@alexkroman1/aai";
import { describeRequests, type EvalNetwork } from "./network.ts";
import type { EvalSession } from "./session-types.ts";

/** Longest spoken line kept, per line. */
const LINE_MAX = 300;
/** Longest tool argument list, and longest tool result, kept per call. */
const TOOL_FIELD_MAX = 200;
/** Most transcript lines kept; the TAIL is kept, since a failure is usually late. */
const MAX_LINES = 40;
/** Most refused requests listed. */
const MAX_REFUSED = 5;

/** `text` cut to `max` characters, the cut named. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}

/** One transcript line for `e`, or `undefined` for an event a reader does not need. */
function lineFor(e: SessionEvent, results: ReadonlyMap<string, string>): string | undefined {
  if (e.type === "user-transcript.committed") return `User: ${clip(e.text, LINE_MAX)}`;
  if (e.type === "agent-transcript.committed") return `Agent: ${clip(e.text, LINE_MAX)}`;
  if (e.type !== "tool.called") return undefined;
  const result = results.get(e.toolCallId);
  const answered =
    result === undefined ? " (never completed)" : ` -> ${clip(result, TOOL_FIELD_MAX)}`;
  return `  [${e.toolName}(${clip(JSON.stringify(e.args), TOOL_FIELD_MAX)})${answered}]`;
}

/**
 * The network's refused requests, the first {@link MAX_REFUSED} DISTINCT ones
 * named — a retried request once, with its count.
 */
function refusedLines(network: EvalNetwork | undefined): string[] {
  const refused = network?.refused() ?? [];
  if (refused.length === 0) return [];
  const distinct = describeRequests(refused);
  const lines = [`refused by the eval network (${refused.length}):`];
  for (const line of distinct.slice(0, MAX_REFUSED)) lines.push(`  ${line}`);
  if (distinct.length > MAX_REFUSED) lines.push(`  …and ${distinct.length - MAX_REFUSED} more`);
  return lines;
}

/**
 * The session as `User:`/`Agent:` lines with each tool call beneath the turn
 * that made it, as `[tool(args) -> result]`, then any request the network
 * REFUSED — the last 40 lines when there are more, each spoken line cut at 300
 * characters and each tool field at 200.
 *
 * It is what a failing `describeEval` case carries under its assertion, and
 * what the `AAI_EVAL_REPEAT` summary prints under an UNSTABLE one. Public for
 * a suite that wants the same view itself — in an assertion's message, or a
 * log of its own.
 *
 * ```ts
 * import { type EvalSession, transcriptOf } from "@alexkroman1/aai-runtime/eval";
 *
 * export function explain(session: EvalSession): string {
 *   return `the call so far:\n${transcriptOf(session)}`;
 * }
 * ```
 *
 * @param session - Anything with the session's event stream: an
 *   `EvalSession`, an `EvalTextAgent`.
 * @param network - The case's fake network, whose refused requests are listed
 *   after the lines — a retried request once, with its count.
 */
export function transcriptOf(session: Pick<EvalSession, "events">, network?: EvalNetwork): string {
  const events = session.events();
  const results = new Map<string, string>();
  for (const e of events) if (e.type === "tool.completed") results.set(e.toolCallId, e.result);
  const lines = events.flatMap((e) => lineFor(e, results) ?? []);
  const kept =
    lines.length <= MAX_LINES
      ? lines
      : [`(${lines.length - MAX_LINES} earlier line(s) omitted)`, ...lines.slice(-MAX_LINES)];
  kept.push(...refusedLines(network));
  return kept.length === 0 ? "(nothing was said)" : kept.join("\n");
}
