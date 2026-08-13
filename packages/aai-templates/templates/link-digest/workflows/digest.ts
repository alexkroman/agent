// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the link digest: a `"use workflow"` body and its steps,
 * and the steps really read the page and really call a model.
 *
 * The rules are the same ones `research-desk/workflows/research.ts` spells out
 * — the body is replayed from the top on every resume, so it holds no live
 * handle and makes no undurable decision, and a step's arguments and return
 * value cross a queue and so must be JSON-shaped and small. Read that file for
 * the full argument, including where the API key comes from (a step is handed no
 * `ToolContext`, so `requireStepEnv` is what makes an authenticated call
 * possible at all). What THIS one adds is the case where NOBODY IS WAITING.
 *
 * A voice agent's run is started by a caller who is on the line. This one is
 * started by a form: the page has the `runId` and the tab may be closed the
 * instant after, which is exactly why the surface is an HTTP API over a durable
 * run rather than a request that holds a socket open.
 *
 * ## Two steps, because they fail differently
 *
 * `fetchArticle` reaches a stranger's web server; `summarize` reaches the model.
 * Splitting them is what makes a rate-limited model call replay the FETCH from
 * the journal instead of hammering someone's site again — and it is why the
 * fetched text crosses a queue between them, which is what the cap on it is for.
 */

import { StepGenerateError, safeJsonParse, stepGenerate } from "@alexkroman1/aai/utils";
import { FatalError, getWritable, sleep } from "workflow";

/** How long the digest sits before it is filed, so the wait is visible in dev. */
const SETTLE = "10 seconds";

/**
 * Characters of article text carried between the two steps.
 *
 * The cap is the pass-an-id-not-a-payload rule meeting a case where the payload
 * IS the work: the text has to cross the queue, so it is bounded rather than
 * trusted. 24k characters is several thousand words — past where an extra page
 * of boilerplate changes the summary.
 */
const MAX_ARTICLE_CHARS = 24_000;

/** Points the digest reduces a page to. */
const POINTS = 3;

/** The page fetch's deadline. `fetch` has none of its own, and a hung step never ends. */
const FETCH_TIMEOUT_MS = 30_000;

/** What one digest pass produces. Small and JSON-shaped, like every step result. */
export type Digest = {
  url: string;
  headline: string;
  points: string[];
};

/** What the page actually said, on its way from one step to the next. */
export type Article = {
  url: string;
  /** The `<title>`, or the hostname when there is none. */
  title: string;
  /** Readable text, capped — see {@link MAX_ARTICLE_CHARS}. */
  text: string;
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

  const article = await fetchArticle(input.url);
  const digest = await summarize(article);

  // Suspended, not blocked: the sandbox is free to exit here and the run
  // resumes when it comes due. Nothing about the code changes if it is
  // `"6 hours"` — which is the interesting version, and the one that makes an
  // overnight digest a digest rather than a slow request.
  await sleep(SETTLE);

  return { ...digest, filedAt: await file(digest) };
}

/**
 * Read the page.
 *
 * A step, so it runs once per successful execution and its result is journaled;
 * a replay returns that result instead of fetching again — which matters here
 * more than usual, because the far side is somebody else's web server.
 */
export async function fetchArticle(url: string): Promise<Article> {
  "use step";

  const { hostname } = new URL(url);
  await report(`Reading ${hostname}…`);

  const response = await fetch(url, {
    // Some sites answer a bare fetch with a challenge page; asking for HTML at
    // least says what we want. Nothing here defeats a real bot wall, and a
    // template pretending otherwise would be the dishonest version.
    headers: { Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) throw fetchFailure(response, url);

  const html = await response.text();
  const text = extractText(html);
  if (text.length < 200) {
    // Not transient: the same URL returns the same near-empty page on a retry.
    // A JS-rendered site is the usual cause and no number of attempts fixes it.
    throw new FatalError(`${hostname} returned no readable text — is the page rendered in JS?`);
  }
  return { url, title: extractTitle(html) ?? hostname, text };
}

/**
 * Reduce the page to a headline and a few points.
 *
 * Separate from the fetch on purpose: a rate-limited model call replays the
 * fetch from the journal rather than hitting a stranger's server again. The
 * whole Node runtime is available here, unlike in the body.
 */
export async function summarize(article: Article): Promise<Digest> {
  "use step";

  await report("Pulling out the claims worth keeping.");

  const reply = await ask(`Title: ${article.title}\nURL: ${article.url}\n\n${article.text}`, {
    system:
      `You digest articles. Reply with JSON only: {"headline": string, "points": string[]}. ` +
      `Give exactly ${POINTS} points. No markdown fence, no preamble.`,
  });

  const parsed = safeJsonParse(stripFence(reply));
  if (!isDigestShape(parsed)) {
    // A PLAIN throw, unlike the fatal ones above, and the distinction is the
    // whole retry policy: a model that answered with prose instead of JSON may
    // well answer correctly on the next attempt, where a 401 or an empty page
    // will not.
    throw new Error("The model did not return the JSON shape this step asked for.");
  }
  return {
    url: article.url,
    headline: parsed.headline,
    points: parsed.points.slice(0, POINTS),
  };
}

/** A rate limit — and a model that ignored the format — are both expected here. */
summarize.maxRetries = 5;

/**
 * File the digest.
 *
 * Separate from `summarize` on purpose: two steps mean a crash between them
 * replays the expensive half for free and re-issues only the cheap one.
 * Returning the timestamp rather than reading a clock in the BODY is the same
 * rule — a step's result is journaled and therefore stable across replays,
 * where `Date.now()` in the body would change on every one.
 */
export async function file(_digest: Digest): Promise<string> {
  "use step";

  await report("Filing the digest.");
  // A real desk would write the digest to its database here. The stub writes
  // nothing, which is what the `_` says — and it is a stub because `ctx.db` is
  // the half of a tool context a step still cannot reach.
  return new Date().toISOString();
}

// ---- Pure helpers -----------------------------------------------------------

/** The document's `<title>`, when it has one. */
export function extractTitle(html: string): string | undefined {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return title ? decodeEntities(title).replace(/\s+/g, " ").trim() || undefined : undefined;
}

/**
 * Reduce HTML to the text a model should read.
 *
 * Deliberately crude, and the crudeness is the honest part: a real extractor is
 * a readability implementation and a dependency, where this is four `replace`
 * calls that get most of an article. What it MUST do is drop `<script>` and
 * `<style>` CONTENT — stripping tags alone leaves a page's JavaScript in the
 * prompt, which is both expensive and a way to smuggle instructions past the
 * reader.
 */
export function extractText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ARTICLE_CHARS);
}

/** The five entities that survive tag-stripping often enough to matter. */
function decodeEntities(text: string): string {
  return (
    text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      // `&amp;` LAST, or `&amp;lt;` decodes twice into a `<` the page never had.
      .replace(/&amp;/g, "&")
  );
}

/** Unwrap a ```json fence, which models add however firmly they are told not to. */
export function stripFence(reply: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(reply);
  return (fenced?.[1] ?? reply).trim();
}

/** Is this the shape `summarize` promised its caller? */
function isDigestShape(value: unknown): value is { headline: string; points: string[] } {
  if (value === null || typeof value !== "object") return false;
  const shape = value as { headline?: unknown; points?: unknown };
  return (
    typeof shape.headline === "string" &&
    shape.headline.trim() !== "" &&
    Array.isArray(shape.points) &&
    shape.points.length > 0 &&
    shape.points.every((point) => typeof point === "string")
  );
}

// ---- The model call ---------------------------------------------------------

/**
 * `stepGenerate`, with this desk's retry POLICY on top.
 *
 * The SDK classifies the failure (`StepGenerateError.retryable`) and stops
 * there, deliberately: whether a terminal failure should burn the step's
 * remaining attempts is the caller's call, and `FatalError` belongs to
 * `workflow`, which the SDK cannot import onto the CLI's startup path.
 * `research-desk` carries the same three lines for the same reason.
 */
async function ask(prompt: string, opts: { system: string }): Promise<string> {
  return await stepGenerate(prompt, opts).catch(stopOrRetry);
}

/**
 * Turn a terminal gateway failure into one the DevKit will not retry.
 *
 * A plain function rather than a `throw` inside a `catch`: `FatalError` takes
 * only a message — no `cause` — so constructing one in a catch block loses the
 * original error where the linter (rightly) expects it preserved. Here the
 * original is the ARGUMENT, and a retryable one is re-thrown untouched.
 */
function stopOrRetry(err: unknown): never {
  if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
  throw err;
}

/**
 * The retryable/terminal split, for the page we were pointed at.
 *
 * The same judgement `StepGenerateError.retryable` makes for the gateway: a 404
 * or a 403 answers the same way on the fourth attempt, while a rate limit or a
 * 5xx is exactly what retries are for.
 */
function fetchFailure(response: Response, url: string): Error {
  const message = `GET ${url} failed: HTTP ${response.status}`;
  return isTransient(response.status) ? new Error(message) : new FatalError(message);
}

/** Will another attempt plausibly answer differently? */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

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
 *
 * See `research-desk`'s copy for why these twelve lines are not an SDK helper.
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
