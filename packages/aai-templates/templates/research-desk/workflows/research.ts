// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the research desk: a `"use workflow"` body and its steps.
 *
 * **This file is the one place in a template where the Workflow Development Kit
 * is imported directly**, and that is deliberate: the SDK re-exports none of it.
 * An author reaches for `sleep` from `workflow` the same way they reach for `z`
 * from `zod`.
 *
 * ## Why the body is here and not in `agent.ts`
 *
 * The WDK builder scans `workflows/` at build time and rewrites every function
 * carrying a directive. `agent.ts` is not scanned, so a body written there would
 * never be transformed — it would run inline on the first call, once, with no
 * durability and no error saying so.
 *
 * ## The two rules a body has to obey
 *
 * **1. The body is replayed from the top on every resume.** So it may hold no
 * live handle and must make no undurable decision: no `Date.now()`, no
 * `Math.random()`, no database call. Everything real happens in a `"use step"`
 * function, which runs at most once per successful execution and is journaled by
 * its result.
 *
 * **2. A step's arguments and return value are serialized.** They cross a queue,
 * so they must be JSON-shaped and small. Pass an id, not a payload.
 *
 * Both rules are why `ctx.db` and `ctx.generate` are not available in a body —
 * see `sleep`'s placement below for what that looks like in practice.
 */

import { sleep } from "workflow";

/** How long the desk sits on a finished draft before filing it. */
const REVIEW_DELAY = "30 seconds";

/** What one research pass produces. */
export type Findings = {
  topic: string;
  summary: string;
  sources: number;
};

/**
 * Research `topic`, sleep on it, then file the result.
 *
 * The `sleep` is the point of the whole mechanism and the reason this cannot be a
 * tool: it suspends the run WITHOUT holding a process open, so the sandbox is
 * free to exit and the run resumes when it comes due. A tool doing the same thing
 * would have to keep the caller on the line for thirty seconds.
 *
 * Thirty seconds is short enough to watch in `aai dev`. Nothing about the code
 * changes if it is `"6 hours"` — which is the interesting version, and the one a
 * real desk would use.
 */
export async function researchFlow(input: { topic: string; requestedBy: string }) {
  "use workflow";

  const findings = await gather(input.topic);

  // Suspended, not blocked. On resume the body re-runs from the top and `gather`
  // returns its journaled result instead of calling the model again.
  await sleep(REVIEW_DELAY);

  const filedAt = await file(input.requestedBy, findings);

  // Whatever this returns is what `ctx.workflows.get(runId)` reports as `output`
  // on a completed run, so it is what the agent reads back to the caller.
  return { topic: findings.topic, summary: findings.summary, sources: findings.sources, filedAt };
}

/**
 * Do the actual research.
 *
 * A step, so it runs once and its result is journaled. A real desk would call a
 * model or a search API here — the whole Node runtime is available, unlike in the
 * body above.
 */
async function gather(topic: string): Promise<Findings> {
  "use step";

  // Stands in for the model call, so the template runs with no API key. The
  // shape is what matters: a step returns SMALL, serializable data.
  return {
    topic,
    summary: `Three angles worth pursuing on ${topic}, with the trade-offs between them.`,
    sources: 3,
  };
}

/**
 * File the findings.
 *
 * Separate from `gather` on purpose. Two steps mean a crash between them replays
 * the research for free and re-issues only the filing — one step doing both would
 * redo the expensive half every time the cheap half failed.
 */
async function file(requestedBy: string, findings: Findings): Promise<string> {
  "use step";

  // A real desk would write to `ctx.db` here — which is available in a step and
  // not in a body. Returning the timestamp rather than reading a clock in the
  // body is the same rule: a step's result is journaled, so it is stable across
  // replays, where `Date.now()` in the body would change on every one.
  return new Date().toISOString();
}
