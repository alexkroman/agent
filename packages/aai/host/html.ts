// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading somebody else's markup — a real parse, once, for the steps that do it.
 *
 * ## Why this exists
 *
 * Two shipped templates scrape the web with regexes. `link-digest` reduces a
 * fetched page to text with three `replace` calls; `podcast-digest` reads an
 * RSS feed with `indexOf` slicing (`textBetween`), an
 * `<item[\s\S]*?<\/item>` alternation, a hand-written `stripCdata`, and a
 * `RegExp` built per `<meta>` lookup. Together that is ~65 lines of parser,
 * and every one of those lines is a claim about a language with syntax that a
 * pattern cannot see:
 *
 * - **A `>` inside a quoted attribute ends a tag.** `<[^>]+>` cuts
 *   `<a title="a > b">` in half and leaves `b">` in the text.
 * - **An unclosed `<script>` leaks its whole body.** `<script[^>]*>[\s\S]*?<\/script>`
 *   needs the close tag, so a truncated page — a byte cap, a dropped
 *   connection — removes nothing and the `<[^>]+>` pass strips only the open
 *   tag, putting the script into the prose. Measured: `Before var leaked = 1;`
 *   against `Before`.
 * - **`indexOf("<title>")` finds the FIRST one at any depth.** In an Atom feed
 *   the channel title and the first entry's title are both `<title>`, so a
 *   channel-level read can answer with an entry's.
 * - **CDATA is not decoded, and feeds put HTML in it.** `stripCdata` peels the
 *   wrapper and leaves `&amp;` behind, so the model reads the entity.
 *
 * The SDK already carries both parsers as dependencies — `htmlparser2` and
 * `html-to-text`, used by `host/page-design.ts`, `host/web-search.ts` and
 * `host/builtin-tools.ts` — and the templates could not reach either, because
 * no published subpath exposed them. That is the whole of the gap: not a
 * missing library, a missing export.
 *
 * ## What is here, and what is deliberately not
 *
 * Three functions, each backed by a parse rather than a pattern:
 * {@link htmlToText} (markup to prose), {@link parseFeed} (RSS/Atom to items),
 * and {@link pageMetadata} (the three things a scraper reads off a page's
 * head). They are the intersection of what the two templates actually do —
 * this is not a general scraping toolkit and should not grow into one. A step
 * that needs the DOM wants `htmlparser2` in its own project.
 *
 * `decodeHtmlEntities` on `@alexkroman1/aai/utils` stays exactly as it is, and
 * the two are not competitors: that one decodes six entities with no
 * dependency and runs in a browser bundle, which is what a `client.tsx` needs.
 * This subpath pulls two parsers and is for a Node step.
 *
 * @module html
 */

import { convert } from "html-to-text";
import { DomUtils, parseDocument } from "htmlparser2";

/**
 * The node list `DomUtils` walks, and one element out of it.
 *
 * Taken off `DomUtils`' own signatures rather than imported from `domhandler`:
 * that package is htmlparser2's dependency and not this one's, so naming it
 * would be an undeclared import that resolves today only by hoisting.
 */
type DomNodes = Parameters<typeof DomUtils.findAll>[1];
type DomElement = ReturnType<typeof DomUtils.findAll>[number];

/**
 * How {@link htmlToText} renders, and why each choice is what a STEP wants.
 *
 * The reader is a model or a word count, not a terminal: `wordwrap: false`
 * because a hard-wrapped paragraph costs tokens and reads as line noise once
 * it is inside a prompt; `ignoreHref` because a URL after every link is the
 * single largest source of junk tokens on a real page and the step already has
 * the URL it fetched; images skipped for the same reason. `<script>`,
 * `<style>`, `<head>` and comments are dropped by the converter itself, which
 * is the part the three-`replace` version had to write by hand.
 */
const TEXT_SELECTORS = [
  { selector: "a", options: { ignoreHref: true } },
  { selector: "img", format: "skip" },
];

/** Runs of three or more newlines, left where a dropped block used to be. */
const BLANK_RUN = /\n{3,}/g;

/**
 * Markup as the prose inside it.
 *
 * Tags are removed by a real HTML parse, entities are decoded, block structure
 * becomes blank lines and list items become `* ` bullets — so a page, an email
 * body, or the HTML a feed wrapped in CDATA all arrive as something a model can
 * read. `<script>` and `<style>` bodies never appear in the output.
 *
 * **It is not `decodeHtmlEntities` and does not replace it.** That one is six
 * entities and no dependency, for a `client.tsx`; this is a parser, for a step.
 *
 * @param html Markup. A fragment is fine — it need not be a whole document.
 * @param options `maxChars` truncates the result, which is what a step feeding
 *   a prompt wants: a 400 KB page is a cost, not a better answer. The cut is
 *   plain, with no ellipsis, so a caller composing its own marker is not
 *   fighting one.
 *
 * @example
 * ```ts
 * import { htmlToText } from "@alexkroman1/aai/html";
 *
 * declare const pageHtml: string;
 *
 * htmlToText("<p>Fish &amp; <b>Chips</b></p>"); // "Fish & Chips"
 * htmlToText(pageHtml, { maxChars: 20_000 });
 * ```
 *
 * @public
 */
export function htmlToText(html: string, options?: { maxChars?: number }): string {
  const text = convert(html, { wordwrap: false, selectors: TEXT_SELECTORS })
    .replace(BLANK_RUN, "\n\n")
    .trim();
  const cap = options?.maxChars;
  return cap !== undefined && text.length > cap ? text.slice(0, cap) : text;
}

/** One entry of a feed, with the fields a digest actually reads. */
export type FeedItem = {
  /**
   * The feed's own identifier for this entry — `<guid>` or Atom `<id>` —
   * falling back to the link and then the enclosure URL.
   *
   * A caller asking "have I seen this episode" should key on this and NOT on
   * the title, which publishers edit.
   */
  id: string | undefined;
  /** The entry's title, as text (see {@link parseFeed} on CDATA). */
  title: string | undefined;
  /** The entry's canonical link. */
  link: string | undefined;
  /** The entry's summary or description, as text. */
  description: string | undefined;
  /**
   * When it was published, as an ISO 8601 string.
   *
   * The parse understands RFC 822 (`<pubDate>`) and ISO (`<published>`), which
   * is the split the regex version handled by trying both element names and
   * then handing the raw string on — so a caller had to parse a date whose
   * format depended on the feed.
   */
  published: string | undefined;
  /** The `<enclosure url>` — the audio or video file, when there is one. */
  enclosureUrl: string | undefined;
  /** The `<enclosure type>` MIME type, when the feed declared one. */
  enclosureType: string | undefined;
};

/** A parsed RSS/Atom/RDF feed. */
export type ParsedFeed = {
  /** The channel title, as text — never an entry's, which is a real hazard. */
  title: string | undefined;
  /** Every entry, in document order. */
  items: FeedItem[];
};

/**
 * An RSS, Atom or RDF feed as its channel title and entries.
 *
 * Returns `undefined` when the document is not a feed at all, which is what a
 * caller wants after following a `<link rel="alternate">` that turned out to be
 * an HTML page.
 *
 * **Titles and descriptions come back as TEXT, run through {@link htmlToText}.**
 * Feeds routinely wrap HTML in CDATA — a show note with `<p>` tags and `&amp;`
 * in it is the normal case, not the exotic one — and CDATA is literal by
 * definition, so a parser respecting XML strictly hands a step markup where it
 * asked for a title. The regex version reached the same place by calling
 * `decodeHtmlEntities(stripCdata(…))` at every site; doing it once here is the
 * same decision made in one place.
 *
 * **`enclosureUrl` is read separately from the feed parse**, because
 * htmlparser2's own feed reader maps `<media:content>` into its `media` array
 * and does not surface RSS's plain `<enclosure>` at all. That is the one thing
 * this module adds to the library rather than delegating, and it is still a DOM
 * lookup on the same parse — never a pattern.
 *
 * @example
 * ```ts
 * import { parseFeed } from "@alexkroman1/aai/html";
 *
 * declare const xml: string;
 *
 * const feed = parseFeed(xml);
 * const episodes = feed?.items.filter((item) => item.enclosureUrl !== undefined) ?? [];
 * ```
 *
 * @public
 */
export function parseFeed(xml: string): ParsedFeed | undefined {
  // `dom.children` rather than `dom`: every `DomUtils` reader here takes a node
  // LIST, and a `Document` is not one — passing it typechecks nowhere and would
  // read as an empty feed if it did.
  const nodes = parseDocument(xml, { xmlMode: true }).children;
  const feed = DomUtils.getFeed(nodes);
  if (!feed) return undefined;

  // The library's items and the entry ELEMENTS are two views of one parse, and
  // the zip below is only sound if both views select the SAME set in the same
  // order. So the element side mirrors `getFeed` exactly rather than sweeping
  // the document: scoped to the feed ROOT's children, and to the ONE tag name
  // that root implies. A whole-document `item`-or-`entry` sweep is what a
  // reader writes first and it misaligns on a feed carrying both spellings —
  // which puts one entry's audio on another entry, silently, since every field
  // still looks plausible.
  const elements = entryElements(nodes, feed.type);
  return {
    title: asText(feed.title),
    items: feed.items.map((item, index) => {
      const enclosure = enclosureOf(elements[index]);
      return {
        id: item.id ?? item.link ?? enclosure?.url,
        title: asText(item.title),
        link: item.link,
        description: asText(item.description),
        published: isoOrUndefined(item.pubDate),
        enclosureUrl: enclosure?.url,
        enclosureType: enclosure?.type,
      };
    }),
  };
}

/**
 * The roots `getFeed` recognises, and nothing else — its own `isValidFeed`.
 *
 * Reproduced rather than imported because it is not exported. It is three
 * literals and it is checked by a spec, which is the cheaper half of the trade
 * against reaching into `domutils`, a package this one does not declare.
 */
const FEED_ROOTS = new Set(["rss", "feed", "rdf:RDF"]);

/**
 * The entry ELEMENTS `getFeed` built its items from, in the same order.
 *
 * `feed.type` is `"atom"` for an Atom feed and `"rss"`/`"rdf"` otherwise, which
 * is exactly the branch `getFeed` takes to choose between `<entry>` and
 * `<item>` — so reading it back is what keeps the two views in step.
 */
function entryElements(nodes: DomNodes, type: string): DomElement[] {
  const root = DomUtils.findOne((node) => FEED_ROOTS.has(node.name), nodes, true);
  if (!root) return [];
  const tag = type === "atom" ? "entry" : "item";
  return DomUtils.findAll((node) => node.name === tag, root.children);
}

/** The first `<enclosure>` inside one entry, if it names a URL. */
function enclosureOf(
  entry: DomElement | undefined,
): { url: string; type: string | undefined } | undefined {
  if (!entry) return undefined;
  const found = DomUtils.findOne((node) => node.name === "enclosure", entry.children, true);
  if (!found) return undefined;
  const url = DomUtils.getAttributeValue(found, "url");
  if (url === undefined || url === "") return undefined;
  return { url, type: DomUtils.getAttributeValue(found, "type") };
}

/**
 * A parsed date as ISO, or nothing.
 *
 * The library builds `pubDate` with a bare `new Date(text)` and does not check
 * it, so a feed writing `<pubDate>next Tuesday</pubDate>` yields an Invalid
 * Date — on which `toISOString()` THROWS `RangeError`. That would take down the
 * whole parse over one malformed field, where the regex version this replaces
 * simply handed the raw string on. A caller sorting on this already has to cope
 * with a missing date; it must not have to cope with an exception.
 */
function isoOrUndefined(date: Date | undefined): string | undefined {
  if (date === undefined || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** A feed field as prose, or `undefined` when it was absent or empty. */
function asText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return htmlToText(value) || undefined;
}

/** The three things a scraper reads off a page's `<head>`. */
export type PageMetadata = {
  /** `og:title` if the page declares one, else the `<title>` element. */
  title: string | undefined;
  /** `og:description` if the page declares one, else `<meta name="description">`. */
  description: string | undefined;
  /**
   * Every `<link rel="alternate">` pointing at an RSS or Atom feed, in document
   * order, as the page WROTE them.
   *
   * Left unresolved on purpose: resolving needs the URL the page was fetched
   * from, which this function is not given and should not guess. Resolve with
   * `new URL(href, pageUrl)`.
   */
  feedUrls: string[];
};

/** The title sources {@link pageMetadata} prefers, in order. */
const TITLE_SOURCES = ["og:title", "twitter:title"];

/** The description sources {@link pageMetadata} prefers, in order. */
const DESCRIPTION_SOURCES = ["og:description", "twitter:description", "description"];

/** The two feed types a `<link rel="alternate">` may declare. */
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml"]);

/**
 * Title, description, and any feed links a page advertises.
 *
 * Open Graph is preferred over the `<title>` element because it is what the
 * publisher wrote for a reader elsewhere — a `<title>` usually carries the site
 * name and a separator that a summary does not want.
 *
 * A real parse matters most here. The version this replaces built a `RegExp`
 * per lookup with `<meta[^>]+property=…[^>]+content=…`, which needs the two
 * attributes in that ORDER and has to be written twice to cover the other — and
 * still cannot see a `>` inside a quoted `content`, which is exactly what a
 * description containing an arrow has.
 *
 * @example
 * ```ts
 * import { pageMetadata } from "@alexkroman1/aai/html";
 *
 * declare const html: string;
 * declare const pageUrl: string;
 *
 * const meta = pageMetadata(html);
 * const first = meta.feedUrls[0];
 * const feedUrl = first === undefined ? undefined : new URL(first, pageUrl).toString();
 * ```
 *
 * @public
 */
export function pageMetadata(html: string): PageMetadata {
  const dom = parseDocument(html);
  return {
    title: firstOf(declaredMeta(dom.children), TITLE_SOURCES) ?? titleElement(dom.children),
    description: firstOf(declaredMeta(dom.children), DESCRIPTION_SOURCES),
    feedUrls: feedLinks(dom.children),
  };
}

/**
 * Every `<meta>` the page declares, keyed by `property` OR `name`.
 *
 * Open Graph specifies `property` and HTML specifies `name`, and publishers use
 * both for both — Twitter cards in particular ship under either — so one index
 * over the two is what a reader means. First declaration wins: a page that
 * repeats a property is describing itself once and duplicating, and the head's
 * first answer is the one a scraper elsewhere would have taken.
 */
function declaredMeta(nodes: DomNodes): Map<string, string> {
  const declared = new Map<string, string>();
  for (const meta of DomUtils.findAll((node) => node.name === "meta", nodes)) {
    const key =
      DomUtils.getAttributeValue(meta, "property") ?? DomUtils.getAttributeValue(meta, "name");
    const content = DomUtils.getAttributeValue(meta, "content");
    if (key !== undefined && content !== undefined && !declared.has(key)) {
      declared.set(key, content);
    }
  }
  return declared;
}

/** The first of `keys` the page declared non-empty, trimmed. */
function firstOf(declared: Map<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = declared.get(key)?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * The `<title>` element's text.
 *
 * `findOne` with `recurse` walks in document order, so this is the document's
 * title rather than any later one — the property `indexOf("<title>")` also has
 * for a page and loses for an Atom feed, where the first `<title>` at depth is
 * the channel's and the next is an entry's.
 */
function titleElement(nodes: DomNodes): string | undefined {
  const found = DomUtils.findOne((node) => node.name === "title", nodes, true);
  const text = found ? DomUtils.textContent(found).trim() : "";
  return text === "" ? undefined : text;
}

/** Every `<link>` whose `type` names a feed, in document order, deduped. */
function feedLinks(nodes: DomNodes): string[] {
  const hrefs: string[] = [];
  for (const link of DomUtils.findAll((node) => node.name === "link", nodes)) {
    const type = DomUtils.getAttributeValue(link, "type")?.toLowerCase();
    const href = DomUtils.getAttributeValue(link, "href");
    // `rel` is deliberately not tested: a page may write `rel="alternate home"`
    // or omit it, and the TYPE is the discriminating half either way.
    const isFeed = type !== undefined && FEED_TYPES.has(type) && href !== undefined && href !== "";
    if (isFeed && !hrefs.includes(href)) hrefs.push(href);
  }
  return hrefs;
}
