// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the link digest: a `"use workflow"` body and its steps.
 *
 * The rules are the same ones `research-desk/workflows/research.ts` spells out
 * — the body is replayed from the top on every resume, so it holds no live
 * handle and makes no undurable decision, and a step's arguments and return
 * value cross a queue and so must be JSON-shaped and small. Read that file for
 * the full argument; what this one adds is the case where NOBODY IS WAITING.
 *
 * A voice agent's run is started by a caller who is on the line. This one is
 * started by a form: the page has the `runId` and the tab may be closed the
 * instant after, which is exactly why the surface is an HTTP API over a durable
 * run rather than a request that holds a socket open.
 */

import { getWritable, sleep } from "workflow";

/** How long the digest sits before it is filed, so the wait is visible in dev. */
const SETTLE = "10 seconds";

/**
 * Write one progress line to the run's own stream.
 *
 * This is the only way a run can say anything before it finishes: a snapshot
 * carries a status and, once terminal, an output, so without this the page shows
 * "Working…" for the whole pass. `client.tsx` reads it back with
 * `useWorkflowProgress`.
 *
 * Two properties worth copying. It is called from STEPS and never from the body,
 * the same rule as `ctx.db`: the body replays from the top on every resume, so a
 * line written there is re-emitted on each one. And it is BEST-EFFORT — a run
 * must not fail because its narration could not be written, which is also what
 * lets a spec call a step directly, where there is no run and `getWritable()`
 * throws by design.
 */
async function report(line: string): Promise<void> {
  try {
    const writer = getWritable<string>().getWriter();
    try {
      await writer.write(line);
    } finally {
      // Released rather than closed: a later step writes to the same stream, and
      // a closed stream cannot be reopened.
      writer.releaseLock();
    }
  } catch {
    // No run in scope, or the stream is already gone. Neither is worth a failure.
  }
}

/** What one digest pass produces. Small and JSON-shaped, like every step result. */
export type Digest = {
  url: string;
  headline: string;
  points: string[];
};

/**
 * Fetch a link, summarize it, and file the result.
 *
 * Whatever this returns is what a completed run reports as `output` — so it is
 * literally the page's render model, and `WorkflowOutputOf<typeof digest>` in
 * `client.tsx` is that type, derived rather than restated.
 */
export async function digestFlow(input: { url: string }) {
  "use workflow";

  const digest = await summarize(input.url);

  // Suspended, not blocked: the sandbox is free to exit here and the run
  // resumes when it comes due. Nothing about the code changes if it is
  // `"6 hours"` — which is the interesting version, and the one that makes an
  // overnight digest a digest rather than a slow request.
  await sleep(SETTLE);

  return { ...digest, filedAt: await file(digest) };
}

/**
 * Read the link and reduce it.
 *
 * A step, so it runs once per successful execution and its result is journaled;
 * a replay returns that result instead of fetching again. The whole Node runtime
 * is available here — `fetch`, a model call, a database — unlike in the body.
 */
async function summarize(url: string): Promise<Digest> {
  "use step";

  const { hostname } = new URL(url);
  await report(`Reading ${hostname}…`);

  // Stands in for the fetch and the model call, so the template runs with no
  // API key and no network. The SHAPE is the lesson: small, serializable data.
  await report("Pulling out the claims worth keeping.");
  return {
    url,
    headline: `What ${hostname} is actually saying`,
    points: [
      "The claim it opens with, and who it is aimed at.",
      "The evidence behind that claim, and where it thins out.",
      "What it would take to change the author's mind.",
    ],
  };
}

/**
 * File the digest.
 *
 * Separate from `summarize` on purpose: two steps mean a crash between them
 * replays the expensive half for free and re-issues only the cheap one.
 * Returning the timestamp rather than reading a clock in the BODY is the same
 * rule — a step's result is journaled and therefore stable across replays,
 * where `Date.now()` in the body would change on every one.
 */
async function file(_digest: Digest): Promise<string> {
  "use step";

  await report("Filing the digest.");
  // A real desk would write the digest to its database here — the whole Node
  // runtime is available in a step, unlike in the body above. The stub writes
  // nothing, which is what the `_` says.
  return new Date().toISOString();
}
