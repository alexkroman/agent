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

import { sleep } from "workflow";

/** How long the digest sits before it is filed, so the wait is visible in dev. */
const SETTLE = "10 seconds";

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

  // Stands in for the fetch and the model call, so the template runs with no
  // API key and no network. The SHAPE is the lesson: small, serializable data.
  const { hostname } = new URL(url);
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

  // A real desk would write the digest to its database here — the whole Node
  // runtime is available in a step, unlike in the body above. The stub writes
  // nothing, which is what the `_` says.
  return new Date().toISOString();
}
