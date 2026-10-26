// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the link digest: a workflow body and its steps, and the
 * steps really read the page and really call a model.
 *
 * The rules are the same ones `research-handoff-agent/workflows/research.ts` spells out
 * — the body is replayed from the top on every resume, so it holds no live
 * handle and makes no undurable decision, and a step's arguments and return
 * value cross a queue and so must be JSON-shaped and small. What THIS one adds
 * is the case where NOBODY IS WAITING.
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

import type { WorkflowContext, WorkflowInputOf } from "@alexkroman1/aai";
import { htmlToText, type PageMetadata, pageMetadata } from "@alexkroman1/aai/html";
import { stepFetch, stepGenerateJson, stepInfo, stepReport } from "@alexkroman1/aai/step";
import { FatalError, orFail } from "@alexkroman1/aai/step-errors";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { z } from "zod";
// ERASED at build time: the body names the schema's own output type without a
// runtime cycle back through `agent.ts`.
import type { digestInput } from "../agent.ts";

/**
 * How long the digest sits before it is filed, so the wait is visible in dev.
 * Milliseconds — `ctx.sleep` takes a number or a `Date`.
 */
export const SETTLE_MS = 10_000;

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

/**
 * The model a LAST attempt falls back to.
 *
 * A rate limit is a WAIT (`maxWaits` below) and never spends an attempt, so by
 * the last of the default three the cheap explanation is that this model is not
 * going to produce the shape asked for. A smaller model that returns three
 * plain sentences beats a failed run, so the last try asks a different one.
 *
 * Unset means the gateway default. Point this at a smaller id for a real
 * deployment; the useful part of the pattern is `stepInfo()?.isLastAttempt`,
 * not the id.
 */
const FALLBACK_MODEL: string | undefined = undefined;

/** The page fetch's deadline. HTTP has none of its own, and a hung step never ends. */
const FETCH_TIMEOUT_MS = 30_000;

/** What one digest pass produces. Small and JSON-shaped, like every step result. */
export type Digest = {
  url: string;
  headline: string;
  points: string[];
};

/**
 * The shape the model is asked for, as something that CHECKS.
 *
 * `stepGenerateJson` renders it as JSON Schema into the prompt, validates the
 * reply against it, and throws plainly when the reply misses — which is what a
 * retry is for, since a model that answered with prose may well obey on the
 * next attempt. The per-field rules live on the fields, and the cap on the
 * points is a transform rather than a `.slice` after validation.
 */
const DigestReply = z.object({
  headline: z.string().trim().min(1).describe("One line naming what the page says"),
  points: z
    .array(z.string())
    .min(1)
    .describe(`Exactly ${POINTS} short points`)
    .transform((points) => points.slice(0, POINTS)),
});

/** What the page actually said, on its way from one step to the next. */
export type Article = {
  url: string;
  /** The `<title>`, or the hostname when there is none. */
  title: string;
  /**
   * The page's OWN one-line summary (`og:description`, or the `description`
   * meta tag), absent when it declares neither.
   *
   * Optional rather than an empty string, because the two mean different things
   * to the prompt below — an author's abstract is worth showing a model, and a
   * blank label is worth nothing and costs tokens.
   */
  description?: string;
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
export async function digestFlow(input: WorkflowInputOf<typeof digestInput>, ctx: WorkflowContext) {
  const article = await ctx.step("fetchArticle", () => fetchArticle(input.url));
  // `maxWaits`: a 429 carrying `Retry-After` is waited out rather than charged
  // as an attempt, so the three attempts are spent on the other expected
  // failure — a model that ignored the format.
  const digest = await ctx.step("summarize", () => summarize(article), { maxWaits: 3 });

  // Suspended, not blocked: the sandbox is free to exit here and the run
  // resumes when it comes due. Nothing about the code changes if it is six
  // hours — which is the interesting version, and the one that makes an
  // overnight digest a digest rather than a slow request.
  await ctx.sleep("settle", SETTLE_MS);

  const filedAt = await ctx.step("file", () => file(digest));
  return { ...digest, filedAt };
}

/**
 * Read the page.
 *
 * An ORDINARY exported async function — what makes it a step is the
 * `ctx.step("fetchArticle", …)` that calls it, so it runs once per successful
 * execution and its result is journaled; a replay returns that result instead of
 * fetching again, which matters here more than usual because the far side is
 * somebody else's web server. Being ordinary is also what lets `agent.test.ts`
 * call it directly with no engine in the path.
 */
export async function fetchArticle(url: string): Promise<Article> {
  const { hostname } = new URL(url);
  await stepReport(`Reading ${hostname}…`);

  // `orFail(stepFetch)`: a 404 or a 403 answers the same way on the fourth
  // attempt, while a rate limit is exactly what retries are for, and its
  // `Retry-After` reaches the engine's schedule.
  const response = await orFail(stepFetch)(url, {
    // Some sites answer a bare request with a challenge page; asking for HTML
    // at least says what we want. Nothing here defeats a real bot wall, and a
    // template pretending otherwise would be the dishonest version.
    headers: { Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const html = await response.text();
  const text = extractText(html);
  if (text.length < 200) {
    // Not transient: the same URL returns the same near-empty page on a retry.
    // A JS-rendered site is the usual cause and no number of attempts fixes it.
    // A direct `FatalError`, not `throwFatalStepError`: nothing is being
    // classified here and there is no cause to preserve.
    throw new FatalError(`${hostname} returned no readable text — is the page rendered in JS?`);
  }
  // One parse of the head for both of the things it is worth reading. The
  // description may be absent, and `omitUndefined` is what keeps the key off
  // the object rather than sending a `"description": undefined` across the
  // queue.
  const meta = extractMetadata(html);
  return {
    url,
    title: meta.title ?? hostname,
    text,
    ...omitUndefined({ description: meta.description }),
  };
}

/**
 * Reduce the page to a headline and a few points.
 *
 * Separate from the fetch on purpose: a rate-limited model call replays the
 * fetch from the journal rather than hitting a stranger's server again. The
 * whole Node runtime is available here, unlike in the body.
 */
export async function summarize(article: Article): Promise<Digest> {
  // Which attempt is this? `undefined` outside a run — which is what a spec
  // calling this directly gets — and a spec MEANS the ordinary path, so the
  // fallback is keyed on `=== true` rather than on truthiness. Read
  // `isLastAttempt`, never `attempt === 3`: the ceiling lives at the `ctx.step`
  // call site in `digestFlow`.
  const step = stepInfo();
  const lastChance = step?.isLastAttempt === true;
  const model = lastChance ? FALLBACK_MODEL : undefined;
  await stepReport(
    lastChance
      ? `Last attempt (${step?.attempt} of ${step?.maxAttempts}): asking for something simpler.`
      : "Pulling out the claims worth keeping.",
  );

  const parsed = await orFail(stepGenerateJson)(articlePrompt(article), {
    schema: DigestReply,
    system:
      "You digest articles." +
      // The instruction is blunter on the last try for the same reason the
      // model is different: whatever it has been doing so far is not working.
      (lastChance ? " Keep every point to one short sentence." : ""),
    ...omitUndefined({ model }),
  });

  return { url: article.url, headline: parsed.headline, points: parsed.points };
}

/**
 * File the digest.
 *
 * Separate from `summarize` on purpose: two steps mean a crash between them
 * replays the expensive half for free and re-issues only the cheap one.
 * Returning the timestamp rather than reading a clock in the BODY is the same
 * rule — a step's result is journaled and therefore stable across replays.
 * (The `new Date()` is a BASELINED occurrence of `guard-invariants` rule 30 for
 * that reason: it is inside a step, which is where a clock read belongs.)
 */
export async function file(_digest: Digest): Promise<string> {
  await stepReport("Filing the digest.");
  // A real desk would write the digest to its database here. The stub writes
  // nothing, which is what the `_` says.
  return new Date().toISOString();
}

// ---- Pure helpers -----------------------------------------------------------

/**
 * What the model is SHOWN: the page's own framing, then the page.
 *
 * The description line is the author's own abstract, which is the one thing a
 * page states about itself that the body text usually does not — a news article
 * opens on a scene, and its `og:description` opens on the claim. It is LABELLED
 * rather than pasted in front of the text, and it is no more trusted than the
 * body beside it: both come off a stranger's server, which is why the system
 * prompt states the job and this side of the boundary states nothing.
 *
 * Omitted entirely when the page declares none — a bare `Summary:` reads to a
 * model as an empty summary rather than as an absent one.
 */
export function articlePrompt(article: Article): string {
  const head = [`Title: ${article.title}`, `URL: ${article.url}`];
  if (article.description !== undefined)
    head.push(`The page's own summary: ${article.description}`);
  return `${head.join("\n")}\n\n${article.text}`;
}

/**
 * What the page says about itself in its own head: a name and an abstract.
 *
 * `pageMetadata` prefers `og:title` over the `<title>` element, which is what a
 * digest wants: a `<title>` usually carries the site name and a separator
 * ("Otters and tools | Nature Weekly") that a one-line summary does not. It
 * reads `og:description` and the `description` meta tag the same way.
 *
 * Annotated `PageMetadata` rather than left to inference, and the annotation is
 * what makes the spread below safe: this returns the SDK's own record with two
 * of its fields tidied, so a field the SDK adds later rides through untouched.
 */
export function extractMetadata(html: string): PageMetadata {
  const meta = pageMetadata(html);
  return { ...meta, title: collapse(meta.title), description: collapse(meta.description) };
}

/** One line of it, or nothing — a head field is often indented across three. */
function collapse(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * Reduce HTML to the text a model should read.
 *
 * `htmlToText` is a real HTML parse (`@alexkroman1/aai/html`), which matters
 * most for the thing this MUST do: drop `<script>` and `<style>` CONTENT,
 * because a page's JavaScript in the prompt is both expensive and a way to
 * smuggle instructions past the reader. Whitespace is collapsed afterwards
 * because this text crosses a queue between two steps.
 */
export function extractText(html: string): string {
  return htmlToText(html, { maxChars: MAX_ARTICLE_CHARS }).replace(/\s+/g, " ").trim();
}
