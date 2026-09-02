# html

Reading somebody else's markup — a real parse, once, for the steps that do it.

## Why this exists

Two shipped templates scrape the web with regexes. `link-digest` reduces a
fetched page to text with three `replace` calls; `podcast-digest` reads an
RSS feed with `indexOf` slicing (`textBetween`), an
`<item[\s\S]*?</item>` alternation, a hand-written `stripCdata`, and a
`RegExp` built per `<meta>` lookup. Together that is ~65 lines of parser,
and every one of those lines is a claim about a language with syntax that a
pattern cannot see:

- **A `>` inside a quoted attribute ends a tag.** `<[^>]+>` cuts
  `<a title="a > b">` in half and leaves `b">` in the text.
- **An unclosed `<script>` leaks its whole body.** `<script[^>]*>[\s\S]*?</script>`
  needs the close tag, so a truncated page — a byte cap, a dropped
  connection — removes nothing and the `<[^>]+>` pass strips only the open
  tag, putting the script into the prose. Measured: `Before var leaked = 1;`
  against `Before`.
- **`indexOf("<title>")` finds the FIRST one at any depth.** In an Atom feed
  the channel title and the first entry's title are both `<title>`, so a
  channel-level read can answer with an entry's.
- **CDATA is not decoded, and feeds put HTML in it.** `stripCdata` peels the
  wrapper and leaves `&amp;` behind, so the model reads the entity.

The SDK already carries both parsers as dependencies — `htmlparser2` and
`html-to-text`, used by `host/page-design.ts`, `host/web-search.ts` and
`host/builtin-tools.ts` — and the templates could not reach either, because
no published subpath exposed them. That is the whole of the gap: not a
missing library, a missing export.

## What is here, and what is deliberately not

Three functions, each backed by a parse rather than a pattern:
[htmlToText](#htmltotext) (markup to prose), [parseFeed](#parsefeed) (RSS/Atom to items),
and [pageMetadata](#pagemetadata-1) (the three things a scraper reads off a page's
head). They are the intersection of what the two templates actually do —
this is not a general scraping toolkit and should not grow into one. A step
that needs the DOM wants `htmlparser2` in its own project.

`decodeHtmlEntities` on `@alexkroman1/aai/utils` stays exactly as it is, and
the two are not competitors: that one decodes six entities with no
dependency and runs in a browser bundle, which is what a `client.tsx` needs.
This subpath pulls two parsers and is for a Node step.

## Functions

### htmlToText()

```ts
function htmlToText(html: string, options?: {
  maxChars?: number;
}): string;
```

Markup as the prose inside it.

Tags are removed by a real HTML parse, entities are decoded, block structure
becomes blank lines and list items become `* ` bullets — so a page, an email
body, or the HTML a feed wrapped in CDATA all arrive as something a model can
read. `<script>` and `<style>` bodies never appear in the output.

**It is not `decodeHtmlEntities` and does not replace it.** That one is six
entities and no dependency, for a `client.tsx`; this is a parser, for a step.

#### Parameters

##### html

`string`

Markup. A fragment is fine — it need not be a whole document.

##### options?

`maxChars` truncates the result, which is what a step feeding
  a prompt wants: a 400 KB page is a cost, not a better answer. The cut is
  plain, with no ellipsis, so a caller composing its own marker is not
  fighting one.

###### maxChars?

`number`

#### Returns

`string`

#### Example

```ts
import { htmlToText } from "@alexkroman1/aai/html";

declare const pageHtml: string;

htmlToText("<p>Fish &amp; <b>Chips</b></p>"); // "Fish & Chips"
htmlToText(pageHtml, { maxChars: 20_000 });
```

***

### pageMetadata()

```ts
function pageMetadata(html: string): PageMetadata;
```

Title, description, and any feed links a page advertises.

Open Graph is preferred over the `<title>` element because it is what the
publisher wrote for a reader elsewhere — a `<title>` usually carries the site
name and a separator that a summary does not want.

A real parse matters most here. The version this replaces built a `RegExp`
per lookup with `<meta[^>]+property=…[^>]+content=…`, which needs the two
attributes in that ORDER and has to be written twice to cover the other — and
still cannot see a `>` inside a quoted `content`, which is exactly what a
description containing an arrow has.

#### Parameters

##### html

`string`

#### Returns

[`PageMetadata`](#pagemetadata)

#### Example

```ts
import { pageMetadata } from "@alexkroman1/aai/html";

declare const html: string;
declare const pageUrl: string;

const meta = pageMetadata(html);
const first = meta.feedUrls[0];
const feedUrl = first === undefined ? undefined : new URL(first, pageUrl).toString();
```

***

### parseFeed()

```ts
function parseFeed(xml: string): ParsedFeed | undefined;
```

An RSS, Atom or RDF feed as its channel title and entries.

Returns `undefined` when the document is not a feed at all, which is what a
caller wants after following a `<link rel="alternate">` that turned out to be
an HTML page.

**Titles and descriptions come back as TEXT, run through [htmlToText](#htmltotext).**
Feeds routinely wrap HTML in CDATA — a show note with `<p>` tags and `&amp;`
in it is the normal case, not the exotic one — and CDATA is literal by
definition, so a parser respecting XML strictly hands a step markup where it
asked for a title. The regex version reached the same place by calling
`decodeHtmlEntities(stripCdata(…))` at every site; doing it once here is the
same decision made in one place.

**`enclosureUrl` is read separately from the feed parse**, because
htmlparser2's own feed reader maps `<media:content>` into its `media` array
and does not surface RSS's plain `<enclosure>` at all. That is the one thing
this module adds to the library rather than delegating, and it is still a DOM
lookup on the same parse — never a pattern.

#### Parameters

##### xml

`string`

#### Returns

[`ParsedFeed`](#parsedfeed) \| `undefined`

#### Example

```ts
import { parseFeed } from "@alexkroman1/aai/html";

declare const xml: string;

const feed = parseFeed(xml);
const episodes = feed?.items.filter((item) => item.enclosureUrl !== undefined) ?? [];
```

## Type Aliases

### FeedItem

```ts
type FeedItem = {
  description: string | undefined;
  enclosureType: string | undefined;
  enclosureUrl: string | undefined;
  id: string | undefined;
  link: string | undefined;
  published: string | undefined;
  title: string | undefined;
};
```

One entry of a feed, with the fields a digest actually reads.

#### Properties

##### description

```ts
description: string | undefined;
```

The entry's summary or description, as text.

##### enclosureType

```ts
enclosureType: string | undefined;
```

The `<enclosure type>` MIME type, when the feed declared one.

##### enclosureUrl

```ts
enclosureUrl: string | undefined;
```

The `<enclosure url>` — the audio or video file, when there is one.

##### id

```ts
id: string | undefined;
```

The feed's own identifier for this entry — `<guid>` or Atom `<id>` —
falling back to the link and then the enclosure URL.

A caller asking "have I seen this episode" should key on this and NOT on
the title, which publishers edit.

##### link

```ts
link: string | undefined;
```

The entry's canonical link.

##### published

```ts
published: string | undefined;
```

When it was published, as an ISO 8601 string.

The parse understands RFC 822 (`<pubDate>`) and ISO (`<published>`), which
is the split the regex version handled by trying both element names and
then handing the raw string on — so a caller had to parse a date whose
format depended on the feed.

##### title

```ts
title: string | undefined;
```

The entry's title, as text (see [parseFeed](#parsefeed) on CDATA).

***

### PageMetadata

```ts
type PageMetadata = {
  description: string | undefined;
  feedUrls: string[];
  title: string | undefined;
};
```

The three things a scraper reads off a page's `<head>`.

#### Properties

##### description

```ts
description: string | undefined;
```

`og:description` if the page declares one, else `<meta name="description">`.

##### feedUrls

```ts
feedUrls: string[];
```

Every `<link rel="alternate">` pointing at an RSS or Atom feed, in document
order, as the page WROTE them.

Left unresolved on purpose: resolving needs the URL the page was fetched
from, which this function is not given and should not guess. Resolve with
`new URL(href, pageUrl)`.

##### title

```ts
title: string | undefined;
```

`og:title` if the page declares one, else the `<title>` element.

***

### ParsedFeed

```ts
type ParsedFeed = {
  items: FeedItem[];
  title: string | undefined;
};
```

A parsed RSS/Atom/RDF feed.

#### Properties

##### items

```ts
items: FeedItem[];
```

Every entry, in document order.

##### title

```ts
title: string | undefined;
```

The channel title, as text — never an entry's, which is a real hazard.
