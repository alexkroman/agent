// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the link digest: a workflow body and its steps, and the
 * steps really read the page and really call a model.
 *
 * The rules are the same ones `research-workflow/workflows/research.ts` spells out
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

import type { WorkflowCtx } from "@alexkroman1/aai";
import { htmlToText, pageMetadata } from "@alexkroman1/aai/html";
import { stepInfo, stepReport } from "@alexkroman1/aai/step";
import { FatalError, stepFetchOrFail, stepGenerateJsonOrFail } from "@alexkroman1/aai/step-errors";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { z } from "zod";

/**
 * How long the digest sits before it is filed, so the wait is visible in dev.
 *
 * Milliseconds. `ctx.sleep` takes a number or a `Date` and no duration STRING —
 * one more parser to own, and no call site in the repo passed one.
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
 * `summarize` is given six attempts because two different things go wrong here
 * — a rate limit, and a model that answered with prose — and by the sixth the
 * cheap explanation is that this model is not going to produce the shape asked
 * for. A smaller model that returns three plain sentences beats a failed run, so
 * the last try asks a different one rather than the same one again.
 *
 * Unset means the gateway default, which is the same model the agent's own
 * pipeline resolves. Point this at a smaller id for a real deployment; the
 * useful part of the pattern is `stepInfo()?.isLastAttempt`, not the id.
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
 * The shape the model is asked for, as something that CHECKS rather than
 * something the compiler is told to believe.
 *
 * `stepGenerateJson` validates against this and throws plainly when the reply
 * misses — which is what a retry is for, since a model that answered with prose
 * may well obey on the next attempt. Before the SDK took the schema, this was a
 * hand-written `isDigestShape` guard beside a hand-written fence stripper.
 */
const DigestReply = z.object({
  headline: z.string().trim().min(1),
  points: z.array(z.string()).min(1),
});

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
export async function digestFlow(input: { url: string }, ctx: WorkflowCtx) {
  const article = await ctx.step("fetchArticle", () => fetchArticle(input.url));
  // `maxAttempts: 6` was `summarize.maxRetries = 5` — five retries AFTER the
  // first attempt, so six in all. The retry policy moved from a property on the
  // function to the CALL, which is where it belongs: the same function called
  // from two places may deserve different patience, and a property could not say
  // so. A rate limit and a model that ignored the format are both expected here.
  const digest = await ctx.step("summarize", () => summarize(article), { maxAttempts: 6 });

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

  // `stepFetch`, not `fetch`, and the rule has no exception for a step that
  // makes only one request: the global pins nothing, so it offers h2 in ALPN
  // and a server that takes it multiplexes every concurrent request from this
  // process onto ONE connection — and a capacity limit then arrives as a stream
  // reset with no HTTP status, which `toStepError` below has nothing to read.
  // It also reports a connection failure with its whole `cause` chain instead
  // of a bare `TypeError: fetch failed`. Redirects are followed by default.
  // `stepFetchOrFail` rather than `stepFetch` + an `ok` check: it makes the
  // retryable/terminal split for us — a 404 or a 403 answers the same way on
  // the fourth attempt, while a rate limit is exactly what retries are for, and
  // its `Retry-After` reaches the engine's schedule instead of the default
  // backoff. It also puts the server's own error text in the message.
  const response = await stepFetchOrFail(url, {
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
    // classified here and there is no cause to preserve — this step has simply
    // decided, and the helper is for the `catch` block where the linter would
    // (rightly) want the original error kept.
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
  // Which attempt is this? `undefined` outside a run — which is what a spec
  // calling this directly gets — and a spec MEANS the ordinary path, so the
  // fallback is keyed on `=== true` rather than on truthiness.
  const step = stepInfo();
  const lastChance = step?.isLastAttempt === true;
  // `undefined` on every attempt but the last, which is what lets the option be
  // built with `omitUndefined` rather than a conditional spread — the guard is
  // then the value, which is the case that primitive is for.
  const model = lastChance ? FALLBACK_MODEL : undefined;
  await stepReport(
    lastChance
      ? `Last attempt (${step?.attempt} of ${step?.maxAttempts}): asking for something simpler.`
      : "Pulling out the claims worth keeping.",
  );

  // `stepGenerateJsonOrFail` unwraps the fence a model puts around JSON,
  // parses it, and validates it against `DigestReply` — and throws PLAINLY when
  // any of those misses, which is the whole retry policy in one distinction: a
  // model that answered with prose may answer correctly on the next attempt,
  // where a 401 will not. The `OrFail` suffix is what makes the 401 half
  // terminal: it is `stepGenerateJson` with `throwStepError` already applied.
  const parsed = await stepGenerateJsonOrFail(
    `Title: ${article.title}\nURL: ${article.url}\n\n${article.text}`,
    {
      schema: DigestReply,
      system:
        `You digest articles. Reply with JSON only: {"headline": string, "points": string[]}. ` +
        `Give exactly ${POINTS} points. No markdown fence, no preamble.` +
        // The instruction is blunter on the last try for the same reason the
        // model is different: whatever it has been doing for five attempts is
        // not working.
        (lastChance ? " Keep every point to one short sentence." : ""),
      // Read `isLastAttempt`, never `attempt === 6`: the ceiling lives at the
      // `ctx.step` call site in `digestFlow`, so a number written here degrades
      // early on every run the moment somebody changes it there — silently,
      // because the step still returns an answer.
      ...omitUndefined({ model }),
    },
  );

  return {
    url: article.url,
    headline: parsed.headline,
    points: parsed.points.slice(0, POINTS),
  };
}

/**
 * File the digest.
 *
 * Separate from `summarize` on purpose: two steps mean a crash between them
 * replays the expensive half for free and re-issues only the cheap one.
 * Returning the timestamp rather than reading a clock in the BODY is the same
 * rule — a step's result is journaled and therefore stable across replays,
 * where the same read in the body would change on every one.
 *
 * The `new Date()` below is therefore a BASELINED occurrence of
 * `guard-invariants` rule 30, and this is the reason: it is inside a step, not
 * inside a body. The rule bans a clock read anywhere in a shipped `workflows/`
 * file because the `ctx.step` callback boundary is not decidable from a line;
 * `digestFlow` is what reaches this one, as `ctx.step("file", () =>
 * file(digest))`. Anything at BODY level is the bug, not an exception.
 */
export async function file(_digest: Digest): Promise<string> {
  await stepReport("Filing the digest.");
  // A real desk would write the digest to its database here. The stub writes
  // nothing, which is what the `_` says — and it is a stub because `ctx.db` is
  // the half of a tool context a step still cannot reach.
  return new Date().toISOString();
}

// ---- Pure helpers -----------------------------------------------------------

/**
 * The page's own name for itself.
 *
 * `pageMetadata` prefers `og:title` over the `<title>` element, which is what a
 * digest wants: a `<title>` usually carries the site name and a separator
 * ("Otters and tools | Nature Weekly") that a one-line summary does not.
 */
export function extractTitle(html: string): string | undefined {
  return pageMetadata(html).title?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * Reduce HTML to the text a model should read.
 *
 * `htmlToText` is a real HTML parse (`@alexkroman1/aai/html`, over htmlparser2),
 * which matters most for the thing this MUST do: drop `<script>` and `<style>`
 * CONTENT, because a page's JavaScript in the prompt is both expensive and a way
 * to smuggle instructions past the reader. This was four `replace` calls, and
 * they had a hole exactly there — `<script[^>]*>[\s\S]*?<\/script>` needs the
 * close tag, so a page truncated mid-script (a byte cap, a dropped connection)
 * removed nothing and the tag strip put the whole script into the prompt.
 *
 * Whitespace is collapsed to single spaces afterwards because this text crosses
 * a queue between two steps and the blank lines `htmlToText` uses for block
 * structure are bytes the summary does not read.
 */
export function extractText(html: string): string {
  return htmlToText(html, { maxChars: MAX_ARTICLE_CHARS }).replace(/\s+/g, " ").trim();
}
