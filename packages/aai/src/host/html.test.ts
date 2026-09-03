// Copyright 2026 the AAI authors. MIT license.
/**
 * The cases a pattern cannot see.
 *
 * Every test here is an input the code this module replaces got wrong — a `>`
 * inside an attribute, a tag inside a script, a nested `<title>`, HTML inside
 * CDATA. Asserting the happy path would prove nothing: the regex version
 * handled the happy path fine, which is why it survived.
 */

import { describe, expect, test } from "vitest";
import { htmlToText, pageMetadata, parseFeed } from "./html.ts";

describe("htmlToText", () => {
  test("decodes entities and drops tags", () => {
    expect(htmlToText("<p>Fish &amp; <b>Chips</b></p>")).toBe("Fish & Chips");
  });

  test("a `>` inside a quoted attribute does not end the tag", () => {
    // `<[^>]+>` cuts this in half and leaves `b">` in the output.
    expect(htmlToText('<p><a title="a > b" href="/x">link</a></p>')).toBe("link");
  });

  test("an UNCLOSED script does not leak its body into the prose", () => {
    // The differentiator, measured. `<script[^>]*>[\s\S]*?<\/script>` needs the
    // close tag, so with none it removes nothing and the following `<[^>]+>`
    // strips only the open tag — leaving the whole script in the text. A
    // truncated fetch (a byte cap, a dropped connection) produces exactly this.
    const html = "<p>Before</p><script>var leaked = 1;";
    expect(htmlToText(html)).toBe("Before");
  });

  test("styles and comments never reach the output", () => {
    const html = "<style>.a{color:red}</style><!-- note --><p>Body</p>";
    expect(htmlToText(html)).toBe("Body");
  });

  test("a link's href is not spelled out, since the step already has the URL", () => {
    expect(htmlToText('<a href="https://example.com/very/long">text</a>')).toBe("text");
  });

  test("maxChars truncates plainly, with no ellipsis to strip back off", () => {
    expect(htmlToText("<p>abcdefghij</p>", { maxChars: 4 })).toBe("abcd");
    // Under the cap it is untouched — a cap is not a formatter.
    expect(htmlToText("<p>abc</p>", { maxChars: 40 })).toBe("abc");
  });
});

describe("parseFeed", () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>The Show</title>
      <item>
        <title><![CDATA[Fish &amp; <b>Chips</b>]]></title>
        <link>https://show.example/1</link>
        <guid isPermaLink="false">episode-1</guid>
        <pubDate>Tue, 01 Apr 2025 00:00:00 GMT</pubDate>
        <description>First one</description>
        <enclosure url="https://show.example/1.mp3" type="audio/mpeg" length="9"/>
      </item>
      <item><title>A text post</title><link>https://show.example/note</link></item>
    </channel></rss>`;

  test("the channel title is the CHANNEL's, not the first entry's", () => {
    // `indexOf("<title>")` is right here by luck of document order and wrong
    // for an Atom feed, where the same read finds an entry's title.
    expect(parseFeed(rss)?.title).toBe("The Show");
  });

  test("HTML wrapped in CDATA comes back as text", () => {
    // CDATA is literal by definition, so a strict parse hands back
    // `Fish &amp; <b>Chips</b>`. Feeds put show notes in CDATA constantly.
    expect(parseFeed(rss)?.items[0]?.title).toBe("Fish & Chips");
  });

  test("an RSS enclosure is surfaced — the library's own reader drops it", () => {
    const item = parseFeed(rss)?.items[0];
    expect(item?.enclosureUrl).toBe("https://show.example/1.mp3");
    expect(item?.enclosureType).toBe("audio/mpeg");
  });

  test("an entry with no audio is kept, with no enclosure", () => {
    // A feed legitimately mixes text posts in with episodes; dropping them is
    // the caller's filter to apply, not this parse's.
    const items = parseFeed(rss)?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[1]?.enclosureUrl).toBeUndefined();
  });

  test("pubDate arrives as ISO whatever the feed's own format was", () => {
    expect(parseFeed(rss)?.items[0]?.published).toBe("2025-04-01T00:00:00.000Z");
  });

  test("id prefers the feed's guid, falling back to the link", () => {
    const items = parseFeed(rss)?.items ?? [];
    expect(items[0]?.id).toBe("episode-1");
    expect(items[1]?.id).toBe("https://show.example/note");
  });

  test("an Atom feed reads the same way", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Channel</title>
      <entry><title>Entry one</title><id>urn:1</id>
        <link href="https://a.example/1"/>
        <published>2025-04-01T00:00:00Z</published></entry>
    </feed>`;
    const feed = parseFeed(atom);
    // The nested-`<title>` case: an `indexOf` read answers "Entry one" here.
    expect(feed?.title).toBe("Channel");
    expect(feed?.items[0]?.title).toBe("Entry one");
    expect(feed?.items[0]?.id).toBe("urn:1");
  });

  test("an RSS feed carrying a stray <entry> still puts each audio on ITS OWN item", () => {
    // The alignment hazard. A whole-document `item`-or-`entry` sweep picks up
    // the foreign element too, and every enclosure after it lands on the wrong
    // entry — silently, because each field still looks plausible.
    const mixed = `<rss><channel><title>S</title>
      <entry><title>Foreign</title></entry>
      <item><title>One</title><enclosure url="https://a.example/1.mp3"/></item>
      <item><title>Two</title><enclosure url="https://a.example/2.mp3"/></item>
    </channel></rss>`;
    const items = parseFeed(mixed)?.items ?? [];
    expect(items.map((item) => [item.title, item.enclosureUrl])).toEqual([
      ["One", "https://a.example/1.mp3"],
      ["Two", "https://a.example/2.mp3"],
    ]);
  });

  test("an unparseable pubDate is dropped, not thrown", () => {
    // The library builds `pubDate` with a bare `new Date(text)`, and
    // `toISOString()` on an Invalid Date throws — which would fail the whole
    // parse over one bad field on one entry.
    const bad = `<rss><channel><item><title>E</title><pubDate>next Tuesday</pubDate>
      <enclosure url="https://a.example/1.mp3"/></item></channel></rss>`;
    const items = parseFeed(bad)?.items ?? [];
    expect(items[0]?.published).toBeUndefined();
    // The rest of the entry survives it.
    expect(items[0]?.enclosureUrl).toBe("https://a.example/1.mp3");
  });

  test("an RDF (RSS 1.0) feed reads too — the third root the library accepts", () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <channel><title>Old School</title></channel>
      <item><title>Entry</title><link>https://a.example/1</link>
        <enclosure url="https://a.example/1.mp3"/></item>
    </rdf:RDF>`;
    const feed = parseFeed(rdf);
    expect(feed?.title).toBe("Old School");
    expect(feed?.items[0]?.enclosureUrl).toBe("https://a.example/1.mp3");
  });

  test("a page that is not a feed answers undefined", () => {
    // What a caller gets after following a `rel="alternate"` that turned out
    // to be HTML — it needs to be distinguishable from an empty feed.
    expect(parseFeed("<html><body><p>Not a feed</p></body></html>")).toBeUndefined();
  });
});

describe("pageMetadata", () => {
  test("Open Graph wins over the title element", () => {
    const html = `<html><head>
      <title>Post title | Site Name</title>
      <meta property="og:title" content="Post title">
    </head></html>`;
    expect(pageMetadata(html).title).toBe("Post title");
  });

  test("falls back to the title element when there is no og:title", () => {
    expect(pageMetadata("<html><head><title>Just this</title></head></html>").title).toBe(
      "Just this",
    );
  });

  test("attribute ORDER does not matter, and a `>` in content is safe", () => {
    // The `<meta[^>]+property=…[^>]+content=…` version needed one regex per
    // order and still could not see the arrow.
    const html = `<meta content="Before &gt; after" property="og:description">`;
    expect(pageMetadata(html).description).toBe("Before > after");
  });

  test("reads a description declared with `name` rather than `property`", () => {
    const html = `<meta name="description" content="Plain HTML spelling">`;
    expect(pageMetadata(html).description).toBe("Plain HTML spelling");
  });

  test("feed links come back in document order, deduped and unresolved", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="stylesheet" href="/style.css">
    </head></html>`;
    // Unresolved on purpose: resolving needs the URL the page was fetched from.
    expect(pageMetadata(html).feedUrls).toEqual(["/feed.xml", "/atom.xml"]);
  });

  test("a page declaring nothing answers undefined rather than empty strings", () => {
    const meta = pageMetadata("<html><body><p>Nothing in the head</p></body></html>");
    expect(meta.title).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.feedUrls).toEqual([]);
  });
});
