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
 * ## Regex over a real XML parser, deliberately
 *
 * There is no DOM in a step artifact and no XML parser in the scaffold, so the
 * feed reading below is regular expressions over the raw body. This is the
 * honest trade rather than a shortcut: a podcast feed is machine-generated and
 * the two fields that matter (`<enclosure url>` and `<item>`) are stable across
 * every generator in the wild, so the failure mode is a missing episode rather
 * than a corrupted one. {@link episodeFromItem} drops an item it cannot read a
 * media URL from instead of inventing one.
 */

import { stepFetchOk } from "@alexkroman1/aai/step-errors";
import { isRecord, omitUndefined, report, safeJsonParse } from "@alexkroman1/aai/utils";
import { FatalError } from "workflow";

/** How long any one of these lookups may take before it is a failure. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A show, reduced to what the rest of the run needs — plus the body, when
 * resolving it already had to download one.
 *
 * `xml` is the difference between one request per feed and two. Both web paths
 * fetch the feed to decide whether it IS a feed (`looksLikePodcastFeed`), and
 * without somewhere to put that body the reader downloads the identical
 * document a second time. The Apple and Spotify paths resolve a URL without
 * ever reading the feed, so they leave it unset and the reader fetches once.
 */
export type PodcastFeed = {
  feedUrl: string;
  title: string;
  xml?: string;
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
  "use step";

  await report("Finding recent podcast episodes.");
  const links = parsePodcastChannels(podcastChannels);
  if (links.length === 0) throw new FatalError("Add at least one podcast link.");

  const feeds: PodcastFeed[] = [];
  for (const url of links) feeds.push(await resolvePodcastFeed(url));

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
  if (looksLikePodcastFeed(body)) return feedFrom(url, body);

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
  // The body is carried forward rather than re-fetched — see `PodcastFeed.xml`.
  const verified = await fetchText(discovered);
  if (!looksLikePodcastFeed(verified)) {
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
  const title = metaContent(html, "og:title") ?? textBetween(html, "<title>", "</title>") ?? "";
  const description = metaContent(html, "og:description") ?? "";
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
  const xml = feed.xml ?? (await fetchText(feed.feedUrl));
  const podcastTitle = decodeXml(textBetween(xml, "<title>", "</title>") ?? feed.title);

  return [...xml.matchAll(/<item[\s\S]*?<\/item>/g)]
    .map((match, index) => episodeFromItem(match[0], feed.feedUrl, podcastTitle, index))
    .filter((episode): episode is Episode => episode !== undefined);
}

/** One `<item>`, or nothing when it carries no audio to transcribe. */
export function episodeFromItem(
  item: string,
  feedUrl: string,
  podcastTitle: string,
  index: number,
): Episode | undefined {
  const audioUrl = enclosureUrl(item);
  // Not an error: a feed legitimately mixes text posts in with episodes, and
  // there is nothing for this run to do with one.
  if (!audioUrl) return undefined;

  const guid = stripCdata(
    textBetween(item, "<guid", "</guid>")?.replace(/^[^>]*>/, "") ?? "",
  ).trim();
  const link = decodeXml(stripCdata(textBetween(item, "<link>", "</link>") ?? audioUrl));
  return {
    id: stableEpisodeId(feedUrl, guid || link || audioUrl),
    feedUrl,
    podcastTitle,
    title: decodeXml(
      stripCdata(textBetween(item, "<title>", "</title>") ?? `Episode ${index + 1}`),
    ),
    url: link,
    audioUrl: decodeXml(audioUrl),
    published: decodeXml(
      stripCdata(
        textBetween(item, "<pubDate>", "</pubDate>") ??
          textBetween(item, "<published>", "</published>") ??
          "",
      ),
    ),
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

/** An RSS document that actually carries audio — both halves are required. */
export function looksLikePodcastFeed(xml: string): boolean {
  return /<rss\b/i.test(xml) && /<enclosure\b[^>]*\burl=/i.test(xml);
}

/** The feed a page advertises, in either attribute order. */
export function discoverFeedUrl(html: string, pageUrl: string): string | undefined {
  const match =
    /<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(
      html,
    ) ??
    /<link\b[^>]*href=["']([^"']+)["'][^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i.exec(
      html,
    );
  return match?.[1] ? new URL(decodeXml(match[1]), pageUrl).toString() : undefined;
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

function feedFrom(feedUrl: string, body: string): PodcastFeed {
  return {
    feedUrl,
    title: decodeXml(textBetween(body, "<title>", "</title>") ?? hostOf(feedUrl)),
    xml: body,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function enclosureUrl(item: string): string | undefined {
  return /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i.exec(item)?.[1];
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The iTunes payload, reduced to the three fields this file reads.
 *
 * `omitUndefined` rather than a conditional spread per field: under
 * `exactOptionalPropertyTypes` an absent field and a field set to `undefined`
 * are different types, and this is the SDK's one spelling for the difference.
 */
function appleResults(body: unknown): Array<{ feedUrl?: string; title?: string; artist?: string }> {
  if (!(isRecord(body) && Array.isArray(body.results))) return [];
  return body.results.filter(isRecord).map((result) =>
    omitUndefined({
      feedUrl: asString(result.feedUrl),
      title: asString(result.collectionName) ?? asString(result.trackName),
      artist: asString(result.artistName),
    }),
  );
}

/** A JSON field, when the far side really did send a string. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function textBetween(text: string, start: string, end: string): string | undefined {
  const from = text.indexOf(start);
  if (from < 0) return undefined;
  const to = text.indexOf(end, from + start.length);
  return to < 0 ? undefined : text.slice(from + start.length, to);
}

export function metaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match =
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i").exec(
      html,
    ) ??
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "i").exec(
      html,
    );
  return decodeXml(match?.[1] ?? "").trim() || undefined;
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

/** The five entities a feed actually uses. `&amp;` LAST — see below. */
export function decodeXml(text: string): string {
  return (
    text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Last, and it has to be: decoding it first would turn `&amp;lt;` into `<`
      // rather than the literal `&lt;` the feed asked for.
      .replace(/&amp;/g, "&")
  );
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
