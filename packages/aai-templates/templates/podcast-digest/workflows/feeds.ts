// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning what a person PASTES into a list of episodes with audio.
 *
 * The input field says "podcast links" because that is what somebody has in
 * their clipboard — an Apple Podcasts page, a Spotify show, the show's own
 * homepage, or, if they are the sort of person who knows, the RSS feed itself.
 * Exactly one of those four is directly usable. This module is the funnel that
 * turns the other three into the fourth, and then reads it.
 *
 * ## Why the scraping lives in the TEMPLATE and not the SDK
 *
 * Every function here encodes what a particular vendor's HTML looked like when
 * this was written: the `id(\d+)` in an Apple URL, the `serialized-server-data`
 * script tag, `og:title` on a Spotify page. That is the class of knowledge with
 * the shortest half-life in the file, and the SDK's rule — "the SDK owns
 * never-guess, the template owns what an order id looks like" — puts it here on
 * purpose. A reader who needs a fifth source edits this module; nobody has to
 * wait for an SDK release to do it.
 *
 * ## The one dependency decision worth copying
 *
 * The studio app this template came from reached for two npm packages here:
 * `spotify-uri` to answer "is this a show link", and `@extractus/feed-extractor`
 * to parse RSS — which it then never imported, parsing the XML by hand anyway.
 * Both are gone. `spotify-uri` was replaced by {@link isSpotifyShowUrl}, six
 * lines that ask the `URL` parser the same question, and the unused parser was
 * simply deleted.
 *
 * That is not a general "avoid dependencies" position, it is what a TEMPLATE
 * is: a starter is scaffolded against `scaffold/package.json`, so an import it
 * does not list resolves to nothing and the project fails to build the moment
 * somebody runs it. A template may import the SDK, `workflow`, `zod` and React.
 * Anything else has to earn a place in the scaffold manifest first.
 *
 * ## A real parse, once the SDK could offer one
 *
 * The feed reading below used to be regular expressions over the raw body, on
 * the argument that "there is no DOM in a step artifact and no XML parser in
 * the scaffold". The second half was the load-bearing one and it stopped being
 * true: `@alexkroman1/aai/html` publishes the parsers the SDK already carried
 * for its own builtins, so a template can reach them under the same rule as
 * `zod` — it is the SDK.
 *
 * Three things the patterns got wrong, all of them on feeds that exist:
 *
 * - `textBetween(xml, "<title>", "</title>")` read the FIRST `<title>` at any
 *   depth. In an Atom feed that is the channel's only by luck of ordering; the
 *   same read on an entry-first document answers with an episode's title.
 * - `stripCdata` peeled `<![CDATA[…]]>` and left the HTML inside it. Show notes
 *   are HTML in CDATA as a matter of course, so `&amp;` reached the model as an
 *   entity and `<p>` tags reached it as tags.
 * - `<pubDate>` and `<published>` were tried in turn and the raw string handed
 *   on, so a caller had to parse a date whose format depended on the feed
 *   (RFC 822 from RSS, ISO from Atom).
 *
 * What the patterns got RIGHT is kept: {@link episodeFromItem} still drops an
 * entry it cannot read a media URL from rather than inventing one, because a
 * feed legitimately mixes text posts in with episodes.
 *
 * One regex remains, in {@link extractAppleSerializedFeed}, and it is a
 * different kind of thing: it reaches into ONE vendor's `<script>` tag for a
 * JSON blob, which is vendor knowledge with a short half-life rather than XML
 * parsing. It is the section below's subject, not this one's.
 */

import { type FeedItem, type ParsedFeed, pageMetadata, parseFeed } from "@alexkroman1/aai/html";
import { mapConcurrent, report } from "@alexkroman1/aai/step";
import { FatalError, stepFetchOk } from "@alexkroman1/aai/step-errors";
import { isRecord, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import { z } from "zod";

/** How long any one of these lookups may take before it is a failure. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How many pasted links are resolved at once.
 *
 * Small because the far side is Apple and Spotify, who rate-limit, and because
 * a digest is a handful of shows rather than a fan-out — the win is turning N
 * sequential round trips into a couple of overlapped ones, not saturating a
 * link.
 */
const RESOLVE_CONCURRENCY = 4;

/**
 * A show, reduced to what the rest of the run needs — plus the PARSE, when
 * resolving it already had to do one.
 *
 * `parsed` is the difference between one request per feed and two, and between
 * one parse and three. Both web paths fetch the feed to decide whether it IS a
 * feed, and without somewhere to put the result the reader downloads and
 * re-parses the identical document. Re-parsing is the more expensive half:
 * `parseFeed` builds a DOM and runs `htmlToText` over every item's title AND
 * description, and a podcast feed routinely carries 300+ entries of HTML show
 * notes. The Apple and Spotify paths resolve a URL without ever reading the
 * feed, so they leave it unset and the reader fetches once.
 */
export type PodcastFeed = {
  feedUrl: string;
  title: string;
  parsed?: ParsedFeed;
};

/** One episode with audio attached — the unit everything downstream works on. */
export type Episode = {
  id: string;
  feedUrl: string;
  podcastTitle: string;
  title: string;
  url: string;
  audioUrl: string;
  published: string;
};

/**
 * The step: links in, the newest `maxEpisodes` episodes out.
 *
 * One step rather than one per feed, and that is a judgement about REPLAY
 * rather than about speed. A step's result is journaled, so making this one
 * step means a crash anywhere later in the run replays a single recorded array
 * instead of re-scraping Apple and Spotify — who both rate-limit — to rebuild
 * an identical list. The cost is that a crash INSIDE it redoes all of it, which
 * is seconds of HTTP against work measured in transcription minutes.
 */
export async function discoverEpisodes(
  podcastChannels: string,
  maxEpisodes: number,
): Promise<Episode[]> {
  await report("Finding recent podcast episodes.");
  const links = parsePodcastChannels(podcastChannels);
  if (links.length === 0) throw new FatalError("Add at least one podcast link.");

  // Overlapped, not sequential: each resolution is one to three HTTP round
  // trips with a 30s ceiling, and the links are independent. Bounded rather
  // than a bare `Promise.all` because Apple and Spotify both rate-limit — and
  // legal here because this whole function is a STEP BODY (`ctx.step` wraps it
  // in `digest.ts`), so the journal's name+occurrence rule does not apply to
  // what happens inside it.
  const feeds = await mapConcurrent(links, RESOLVE_CONCURRENCY, resolvePodcastFeed);

  const episodes = (await Promise.all(feeds.map((feed) => readPodcastFeed(feed))))
    .flat()
    .sort((a, b) => publishedAt(b) - publishedAt(a))
    .slice(0, maxEpisodes);

  if (episodes.length === 0) {
    // Fatal, not retryable: the same feeds return the same empty list on the
    // next attempt. The message names the four accepted shapes because "no
    // episodes found" on its own does not tell anyone what to paste instead.
    throw new FatalError(
      "No podcast episodes with audio were found. Paste an Apple Podcasts show link, " +
        "a Spotify show link, an RSS feed URL, or a podcast homepage that advertises one.",
    );
  }

  return episodes;
}

// ---- Resolving a link to a feed ---------------------------------------------

/** The funnel: whatever was pasted becomes a feed URL, or the run stops. */
async function resolvePodcastFeed(url: string): Promise<PodcastFeed> {
  if (isApplePodcastUrl(url)) return await resolveApplePodcastFeed(url);
  if (isSpotifyShowUrl(url)) return await resolveSpotifyPodcastFeed(url);
  return await resolveWebPodcastFeed(url);
}

/**
 * The plain-web case, which is two cases: the URL already IS a feed, or it is a
 * page that advertises one in a `<link rel=alternate>`.
 */
async function resolveWebPodcastFeed(url: string): Promise<PodcastFeed> {
  const body = await fetchText(url);
  // Parsed ONCE and carried: the "is this a feed" test, the channel title and
  // the item list are three reads of one parse, not three parses.
  const direct = parseFeed(body);
  if (carriesAudio(direct)) return feedFrom(url, direct);

  const discovered = discoverFeedUrl(body, url);
  if (!discovered) {
    throw new FatalError(
      `Could not find a podcast RSS feed at ${url}. Use an Apple Podcasts link, a ` +
        "Spotify show link, or the podcast's RSS feed URL.",
    );
  }

  // The advertised URL is verified rather than trusted: plenty of pages point
  // `application/rss+xml` at a blog feed with no audio in it, and finding that
  // out here names the page, where finding it out later names an empty digest.
  // The parse is carried forward rather than redone — see `PodcastFeed.parsed`.
  const verified = parseFeed(await fetchText(discovered));
  if (!carriesAudio(verified)) {
    throw new FatalError(`The feed at ${discovered} does not look like a podcast RSS feed.`);
  }
  return feedFrom(discovered, verified);
}

/**
 * Apple, which has a public lookup API and — when that misses — a page with the
 * answer serialized into it.
 *
 * The fallback exists because the lookup API omits `feedUrl` for some shows
 * while the page still carries it, and losing a show to that is a worse outcome
 * than one extra request on a path that rarely runs.
 */
async function resolveApplePodcastFeed(url: string): Promise<PodcastFeed> {
  const id = /\/id(\d+)/.exec(url)?.[1];
  if (!id) throw new FatalError(`Could not read an Apple Podcasts id from ${url}.`);

  const lookup = await fetchJson(`https://itunes.apple.com/lookup?id=${id}&entity=podcast`);
  const found = appleResults(lookup).find((result) => result.feedUrl);
  if (found?.feedUrl)
    return { feedUrl: found.feedUrl, title: found.title ?? hostOf(found.feedUrl) };

  const html = await fetchText(url);
  const fallback = extractAppleSerializedFeed(html, id);
  if (!fallback) {
    throw new FatalError(
      `Apple Podcasts did not expose a public RSS feed for ${url}. Use the show's RSS feed URL.`,
    );
  }
  return { feedUrl: fallback.feedUrl, title: fallback.title ?? hostOf(fallback.feedUrl) };
}

/**
 * Spotify, which publishes no feed URL at all — so this maps the show back to
 * its feed THROUGH Apple's search, and refuses a low-confidence match.
 *
 * {@link titleMatchesSpotify} is the load-bearing half. A search for a show's
 * title returns neighbours, and silently digesting the wrong podcast is the
 * kind of failure nobody reports as a bug — they just stop trusting the output.
 */
async function resolveSpotifyPodcastFeed(url: string): Promise<PodcastFeed> {
  const html = await fetchText(url);
  // `pageMetadata` already prefers `og:title` over the `<title>` element and
  // falls back to it, which is exactly the two-step this spelled out.
  const meta = pageMetadata(html);
  const title = meta.title ?? "";
  const description = meta.description ?? "";
  const query = `${title} ${description}`.replace(/\s+/g, " ").trim();
  if (!query) throw new FatalError(`Could not read podcast metadata from ${url}.`);

  const search = await fetchJson(
    `https://itunes.apple.com/search?media=podcast&limit=5&term=${encodeURIComponent(query)}`,
  );
  const match = appleResults(search).find(
    (result) => result.feedUrl && titleMatchesSpotify(title, description, result),
  );
  if (!match?.feedUrl) {
    throw new FatalError(`Could not map the Spotify show ${title || url} to a public RSS feed.`);
  }
  return { feedUrl: match.feedUrl, title: match.title ?? title };
}

// ---- Reading a feed ---------------------------------------------------------

/** Every item in the feed that has audio attached, newest first by the caller. */
async function readPodcastFeed(feed: PodcastFeed): Promise<Episode[]> {
  // Already parsed on the web paths; the Apple and Spotify paths resolve a URL
  // without ever reading the feed, so this is where those two download it.
  const parsed = feed.parsed ?? parseFeed(await fetchText(feed.feedUrl));
  // `parsed.title` is the CHANNEL's, which is the whole reason to parse: the
  // `indexOf` read this replaces took the first `<title>` at any depth.
  const podcastTitle = parsed?.title ?? feed.title;

  return (parsed?.items ?? [])
    .map((item, index) => episodeFromItem(item, feed.feedUrl, podcastTitle, index))
    .filter((episode): episode is Episode => episode !== undefined);
}

/** One feed entry, or nothing when it carries no audio to transcribe. */
export function episodeFromItem(
  item: FeedItem,
  feedUrl: string,
  podcastTitle: string,
  index: number,
): Episode | undefined {
  const audioUrl = item.enclosureUrl;
  // Not an error: a feed legitimately mixes text posts in with episodes, and
  // there is nothing for this run to do with one.
  if (audioUrl === undefined) return undefined;

  const link = item.link ?? audioUrl;
  return {
    // `item.id` is the feed's `<guid>` or Atom `<id>`, already falling back to
    // the link and then the enclosure — which is the three-way fallback this
    // function used to spell out.
    id: stableEpisodeId(feedUrl, item.id ?? audioUrl),
    feedUrl,
    podcastTitle,
    title: item.title ?? `Episode ${index + 1}`,
    url: link,
    audioUrl,
    // ISO whatever the feed wrote, so `publishedAt` below sorts RSS and Atom
    // against each other rather than against two different formats.
    published: item.published ?? "",
  };
}

// ---- Pure helpers -----------------------------------------------------------

/** Split the field, trim, drop blanks, and keep the first of any duplicate. */
export function parsePodcastChannels(value: string): string[] {
  return value
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index);
}

/**
 * A Spotify show link, without the `spotify-uri` package the studio app used.
 *
 * The package answers a much bigger question — it parses every Spotify URI and
 * URL shape there is — and this file asks one bit of it. Six lines against a
 * dependency the scaffold does not ship is not a close call.
 */
export function isSpotifyShowUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return isHost(hostname, "spotify.com") && /^\/show\/[^/]+/.test(pathname);
  } catch {
    return false;
  }
}

/** An Apple Podcasts show page, which always carries an `/id<digits>` segment. */
export function isApplePodcastUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return isHost(hostname, "podcasts.apple.com") && /\/id\d+/.test(pathname);
  } catch {
    return false;
  }
}

/**
 * The domain, or a subdomain of it — never a host that merely ENDS with it.
 *
 * A bare `hostname.endsWith("spotify.com")` also matches `notspotify.com`, and
 * `endsWith("podcasts.apple.com")` matches `evilpodcasts.apple.com`. Getting
 * this wrong routes somebody else's host into the vendor-specific branch, which
 * then scrapes it as though the vendor had written it. The dot is the fix, and
 * it is the same shape as the Slack host check in `slack.ts`.
 */
function isHost(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The feed URL Apple serializes into its own show page.
 *
 * Exported because it is the one piece of scraping here with a shape worth
 * pinning in a test — the walk is recursive and the `adamId` match is what
 * stops it returning a RELATED show's feed from the same blob.
 */
export function extractAppleSerializedFeed(
  html: string,
  podcastId: string,
): { feedUrl: string; title?: string } | undefined {
  const script = /<script\b[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(
    html,
  );
  if (!script?.[1]) return undefined;
  return findAppleFeed(safeJsonParse(script[1]), podcastId);
}

/** Depth-first for the record that is BOTH a feed and the show we asked for. */
function findAppleFeed(
  value: unknown,
  podcastId: string,
): { feedUrl: string; title?: string } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAppleFeed(item, podcastId);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  if (typeof value.feedUrl === "string" && value.adamId === podcastId) {
    return typeof value.title === "string"
      ? { feedUrl: value.feedUrl, title: value.title }
      : { feedUrl: value.feedUrl };
  }

  for (const item of Object.values(value)) {
    const found = findAppleFeed(item, podcastId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Is this Apple search hit the Spotify show we started from?
 *
 * Three ways to say yes, because the two catalogues disagree about where the
 * network's name goes — sometimes in the title, sometimes only in the artist.
 */
export function titleMatchesSpotify(
  spotifyTitle: string,
  spotifyArtist: string,
  result: { title?: string; artist?: string },
): boolean {
  const collection = normalizeTitle(result.title ?? "");
  const wanted = normalizeTitle(spotifyTitle);
  if (!(collection && wanted)) return false;
  return (
    collection === wanted ||
    normalizeTitle(`${result.title ?? ""} ${result.artist ?? ""}`).includes(wanted) ||
    normalizeTitle(`${spotifyTitle} ${spotifyArtist}`).includes(collection)
  );
}

/**
 * A parse that actually carries audio — both halves are required.
 *
 * `parseFeed` answering at all is the "is this a feed" half, and it is stricter
 * than the `<rss` test it replaces in the direction that matters: an HTML page
 * mentioning `<rss` in prose is not a feed. It is also wider where being wide is
 * right — an Atom podcast feed has no `<rss` root and was refused outright.
 */
function carriesAudio(parsed: ParsedFeed | undefined): parsed is ParsedFeed {
  return parsed?.items.some((item) => item.enclosureUrl !== undefined) ?? false;
}

/** {@link carriesAudio} over a document that has not been parsed yet. */
export function looksLikePodcastFeed(xml: string): boolean {
  return carriesAudio(parseFeed(xml));
}

/** The first feed a page advertises, resolved against the page's own URL. */
export function discoverFeedUrl(html: string, pageUrl: string): string | undefined {
  // `pageMetadata` reads `<link>` off a parse, so attribute ORDER stops
  // mattering — this needed one regex per order and still could not see a `>`
  // inside a quoted href. It hands hrefs back exactly as the page wrote them,
  // which is why the resolution is here: only the caller knows `pageUrl`.
  const href = pageMetadata(html).feedUrls[0];
  if (href === undefined) return undefined;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    // A page can advertise an href that is not a URL under any base. That is
    // "no feed found", which the caller already has a sentence for.
    return undefined;
  }
}

/**
 * An id that is the SAME on every run for the same episode.
 *
 * Deliberately derived rather than random: the page keys episode cards by it,
 * and a replayed step that produced fresh ids would remount every card. A hash
 * rather than the raw guid because a guid is arbitrary text and this ends up in
 * markup.
 */
export function stableEpisodeId(feedUrl: string, source: string): string {
  let hash = 0;
  for (const char of `${feedUrl}:${source}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `episode-${hash.toString(16)}`;
}

/** Unparseable dates sort last rather than throwing off the whole ordering. */
function publishedAt(episode: Episode): number {
  const parsed = Date.parse(episode.published);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function feedFrom(feedUrl: string, parsed: ParsedFeed): PodcastFeed {
  return {
    feedUrl,
    title: parsed.title ?? hostOf(feedUrl),
    parsed,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** One iTunes hit, reduced to the three fields this file reads. */
type AppleResult = { feedUrl?: string; title?: string; artist?: string };

/**
 * One entry of an iTunes `results` array, reduced on the way through.
 *
 * Every field is `.catch(undefined)`, which is this schema's whole subject: the
 * caller is looking for a hit with a `feedUrl` on it, so a neighbouring entry
 * that spells `collectionName` as a number is a hit that does not match, never
 * a reason to abandon the search. The reduction rides in the `transform` for
 * the same reason the fields are declared here rather than at the call site —
 * `collectionName ?? trackName` is a fact about iTunes' payload, and this is
 * the module that is allowed to know vendor facts.
 *
 * `omitUndefined` rather than a conditional spread per field: under
 * `exactOptionalPropertyTypes` an absent field and a field set to `undefined`
 * are different types, and this is the SDK's one spelling for the difference.
 * It is still needed after a schema, because a field the `.catch` above turned
 * into `undefined` is PRESENT in zod's output holding `undefined` (only an
 * absent field stays absent).
 */
const AppleResultEntry = z
  .object({
    feedUrl: z.string().optional().catch(undefined),
    collectionName: z.string().optional().catch(undefined),
    trackName: z.string().optional().catch(undefined),
    artistName: z.string().optional().catch(undefined),
  })
  .transform(
    (result): AppleResult =>
      omitUndefined({
        feedUrl: result.feedUrl,
        title: result.collectionName ?? result.trackName,
        artist: result.artistName,
      }),
  )
  // An entry that is not an object at all — the one shape the fields above
  // cannot absorb — becomes `null` and is dropped below, rather than taking the
  // whole array down with it. That is the `.filter(isRecord)` this replaces.
  .nullable()
  .catch(null);

/** The iTunes lookup and search payloads, which share the one field read here. */
const AppleResponse = z.object({ results: z.array(AppleResultEntry) });

/**
 * The hits in an iTunes response, and NOTHING is an ordinary answer.
 *
 * `safeParse`, never `parse`: both callers treat an empty list as "no match
 * found" and already have a sentence for it, so a body that is not an object,
 * or one whose `results` is not an array, must degrade rather than fail the
 * run. These are live third-party endpoints reached without an API key — a
 * throw here would turn a rate-limit interstitial into a failed durable run.
 */
function appleResults(body: unknown): AppleResult[] {
  const parsed = AppleResponse.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.results.filter((result) => result !== null);
}

// ---- HTTP -------------------------------------------------------------------

/**
 * Every outbound call in this file, with one timeout and one failure policy.
 *
 * `stepFetchOk` is `stepFetch` plus the non-2xx branch — see its own doc. Three
 * things come with it that a bare `fetch` here would each have to re-derive:
 * HTTP/1.1 (so a rate limit arrives as a `503` with `Retry-After` rather than
 * an h2 stream reset carrying no status), the transient/terminal verdict the
 * DevKit reads, and the far side's own error text in the message — which for
 * the iTunes endpoints is the difference between "403" and a sentence.
 */
async function fetchText(url: string): Promise<string> {
  const response = await stepFetchOk(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return await response.text();
}

/** The same, for the two iTunes endpoints that answer JSON. */
async function fetchJson(url: string): Promise<unknown> {
  return safeJsonParse(await fetchText(url));
}
