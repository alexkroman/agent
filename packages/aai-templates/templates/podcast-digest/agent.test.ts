// Copyright 2026 the AAI authors. MIT license.
/**
 * What this template promises, checked without a network.
 *
 * Four kinds of thing are checked:
 *
 * - The DECLARATION — the config a deploy validates and the schema a `start()`
 *   is checked against.
 * - The PURE helpers, pulled out of the flow for exactly this reason.
 * - The STEPS, directly. A step is an ordinary exported async function, so its
 *   HTTP handling, its partial-failure policy and its `FatalError` guards are
 *   all reachable — `installStubStepFetch` answers the network and
 *   `stubGateway` answers the model.
 * - The BODY, twice. `createWorkflowCtx` records what it asked for (the digest
 *   loop, the shrinking pending set, the sleep BETWEEN digests and never after
 *   the last), and `runWorkflow` runs it on the real replay engine — which is
 *   what this file used to say a unit test could not do, on the ground that a
 *   body "is only durable once the Workflow DevKit's build has transformed it".
 *   That stopped being true when the DevKit was replaced.
 *
 * The cases worth having are the ones where a mistake is SILENT: a schema that
 * accepts a webhook pointing anywhere, a Slack payload in the shape the other
 * kind of URL wants, feed parsing that quietly drops episodes, and an episode
 * that fails to transcribe taking the whole digest down with it.
 */

import { type FeedItem, parseFeed } from "@alexkroman1/aai/html";
import {
  createWorkflowCtx,
  parseSchemaInput,
  schemaInputIssues,
  stubGatewayRoute,
} from "@alexkroman1/aai/testing";
import {
  installStubStepFetch,
  installStubGateway as stubGateway,
} from "@alexkroman1/aai/testing/vitest";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { dailyDigest } from "./agent.ts";
import {
  dailyDigestFlow,
  formatScheduleInterval,
  POLL_DELAY_MS,
  pollTranscript,
  scheduleIntervalMs,
  submitTranscript,
  summarizeTranscript,
  timestamp,
} from "./workflows/digest.ts";
import {
  discoverEpisodes,
  discoverFeedUrl,
  episodeFromItem,
  extractAppleSerializedFeed,
  isApplePodcastUrl,
  isSpotifyShowUrl,
  looksLikePodcastFeed,
  parsePodcastChannels,
  stableEpisodeId,
  titleMatchesSpotify,
} from "./workflows/feeds.ts";
import { renderDigestMessage, sendDigestToSlack } from "./workflows/slack.ts";

/**
 * Validate through the SDK's reader, as `start()` does.
 *
 * `schemaInputIssues` / `parseSchemaInput` rather than a reach through
 * `["~standard"].validate`: that is the vendor WIRE contract, and whether it
 * answers synchronously or with a promise is the vendor's business — a missing
 * `await` there leaves `.issues` undefined and every rejecting case below passes
 * for the wrong reason.
 */
const issues = (input: unknown) => schemaInputIssues(dailyDigest.input, input, "dailyDigest");

/** A complete, valid input — each case below changes one field of it. */
const VALID = {
  podcastChannels: "https://example.com/feed.xml",
  slackWebhookUrl: "https://hooks.slack.com/services/T000/B000/abc123",
};

const EPISODE = {
  id: "episode-1",
  feedUrl: "https://example.com/feed.xml",
  podcastTitle: "Example Podcast",
  title: "Example Episode",
  url: "https://example.com/episode",
  audioUrl: "https://example.com/audio.mp3",
  published: "Fri, 21 Aug 2026 00:00:00 GMT",
  transcriptSource: "assemblyai" as const,
  summary: "A concise episode summary.",
  keyPoints: ["First point", "Second point"],
};

const slackInput = (slackWebhookUrl: string) => ({
  slackWebhookUrl,
  slackWorkflowTextParam: "text",
  podcastChannels: "https://example.com/feed.xml",
  episodes: [EPISODE],
  digestNumber: 1,
  totalDigests: 2,
});

describe("the declaration", () => {
  test("is a workflow app with one workflow and a static page", () => {
    expect(agentDef.name).toBe("Podcast Digest");
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["dailyDigest"]);
    expect(agentDef.workflows?.dailyDigest).toBe(dailyDigest);
  });

  test("names the one credential its steps read", () => {
    // A workflow app declares no providers, so nothing else in the config can
    // name this — which is what makes a deploy able to check for it.
    expect(agentDef.requiredEnv).toEqual(["ASSEMBLYAI_API_KEY"]);
  });
});

describe("input schema", () => {
  test("accepts a minimal input and applies every default", async () => {
    // `parseSchemaInput` throws naming every issue, so the failure arm needs no
    // hand-written narrowing and a refusal reports WHAT was refused.
    //
    // These defaults are no longer restated anywhere: `DigestInput` is
    // `WorkflowInputOf<typeof dailyDigest>`, the schema's OUTPUT, so the body
    // reads them already applied instead of re-implementing each one with `??`.
    const parsed = await parseSchemaInput(dailyDigest.input, VALID, "dailyDigest");
    expect(parsed).toMatchObject({
      slackWorkflowTextParam: "text",
      maxEpisodesPerDigest: 5,
      intervalEvery: 1,
      intervalUnit: "days",
      daysToRun: 7,
    });
  });

  test("trims the webhook before validating it", async () => {
    expect(
      await issues({
        ...VALID,
        slackWebhookUrl: "  https://hooks.slack.com/services/T000/B000/abc123  ",
      }),
    ).toBeUndefined();
  });

  test.each([
    ["a workflow trigger", "https://hooks.slack.com/triggers/T000/B000/abc"],
    ["the gov host", "https://hooks.slack-gov.com/services/T000/B000/abc"],
  ])("accepts %s", async (_label, slackWebhookUrl) => {
    expect(await issues({ ...VALID, slackWebhookUrl })).toBeUndefined();
  });

  /**
   * The one that matters. This value becomes the target of a POST carrying
   * summarized content, so a schema accepting any URL is an exfiltration
   * endpoint somebody can type into a form.
   */
  test.each([
    ["a non-Slack host", "https://example.com/services/T000/B000/abc"],
    ["a lookalike host", "https://hooks.slack.com.evil.test/services/abc"],
    ["plain http", "http://hooks.slack.com/services/T000/B000/abc"],
    ["no path", "https://hooks.slack.com"],
  ])("rejects %s as a webhook", async (_label, slackWebhookUrl) => {
    expect(await issues({ ...VALID, slackWebhookUrl })).toBeDefined();
  });

  test.each([
    ["a non-URL channel", { podcastChannels: "not a url" }],
    ["one bad entry among good ones", { podcastChannels: "https://a.test/f.xml, nope" }],
    ["an empty channel list", { podcastChannels: "" }],
    ["a variable name that is not an identifier", { slackWorkflowTextParam: "2 text!" }],
    ["more episodes than allowed", { maxEpisodesPerDigest: 21 }],
    ["a fractional episode count", { maxEpisodesPerDigest: 1.5 }],
    ["more digests than allowed", { daysToRun: 31 }],
    ["an unknown interval unit", { intervalUnit: "fortnights" }],
  ])("rejects %s", async (_label, patch) => {
    expect(await issues({ ...VALID, ...patch })).toBeDefined();
  });
});

describe("podcast links", () => {
  test("splits, trims, and keeps the first of any duplicate", () => {
    expect(
      parsePodcastChannels(" https://one.test/rss,https://two.test/feed, https://one.test/rss "),
    ).toEqual(["https://one.test/rss", "https://two.test/feed"]);
  });

  test.each([
    ["https://podcasts.apple.com/us/podcast/example/id1473872585", true],
    ["https://podcasts.apple.com/us/podcast/example", false],
    ["https://example.com/us/podcast/id123", false],
    // A host that merely ENDS with the domain is a different host.
    ["https://evilpodcasts.apple.com/us/podcast/id123", false],
    ["not a url", false],
  ])("isApplePodcastUrl(%s) === %s", (url, expected) => {
    expect(isApplePodcastUrl(url)).toBe(expected);
  });

  /** The replacement for the `spotify-uri` dependency — see `feeds.ts`. */
  test.each([
    ["https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk", true],
    ["https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk?si=abc", true],
    ["https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk", false],
    ["https://open.spotify.com/show/", false],
    ["https://notspotify.com/show/abc", false],
    ["not a url", false],
  ])("isSpotifyShowUrl(%s) === %s", (url, expected) => {
    expect(isSpotifyShowUrl(url)).toBe(expected);
  });
});

describe("reading a feed", () => {
  /**
   * One entry, through the REAL parse.
   *
   * `episodeFromItem` takes a `FeedItem` now rather than a slice of XML, and
   * building one by hand would test the mapping against a literal somebody
   * typed. Going through `parseFeed` keeps the fixture what a feed actually
   * says, which is where the interesting cases (CDATA, date formats, a missing
   * enclosure) live.
   */
  const itemOf = (itemXml: string): FeedItem => {
    const item = parseFeed(`<rss><channel>${itemXml}</channel></rss>`)?.items[0];
    if (!item) throw new Error("fixture did not parse as one feed item");
    return item;
  };

  const ITEM = itemOf(
    "<item><title>An Episode</title><link>https://example.com/ep</link>" +
      '<guid isPermaLink="false">guid-1</guid><pubDate>Fri, 21 Aug 2026 00:00:00 GMT</pubDate>' +
      '<enclosure url="https://example.com/a.mp3" type="audio/mpeg"/></item>',
  );

  test("reads the fields a digest needs off an item", () => {
    expect(episodeFromItem(ITEM, "https://example.com/feed.xml", "Show", 0)).toMatchObject({
      title: "An Episode",
      url: "https://example.com/ep",
      audioUrl: "https://example.com/a.mp3",
      // ISO, not the RFC 822 the feed wrote — so an RSS and an Atom feed sort
      // against each other instead of against two formats.
      published: "2026-08-21T00:00:00.000Z",
    });
  });

  test("HTML inside CDATA arrives as text, not as markup", () => {
    // The case `stripCdata` got wrong: it peeled the wrapper and left the
    // entity and the tags for the model to read.
    const item = itemOf(
      "<item><title><![CDATA[Fish &amp; <b>Chips</b>]]></title>" +
        '<enclosure url="https://example.com/a.mp3"/></item>',
    );
    expect(episodeFromItem(item, "https://example.com/feed.xml", "Show", 0)?.title).toBe(
      "Fish & Chips",
    );
  });

  /** A feed legitimately mixes text posts in; there is nothing to transcribe. */
  test("drops an item with no audio rather than inventing a URL", () => {
    const noAudio = itemOf("<item><title>A Post</title><link>https://example.com/p</link></item>");
    expect(episodeFromItem(noAudio, "https://example.com/feed.xml", "Show", 0)).toBeUndefined();
  });

  test("gives the same episode the same id on every run", () => {
    // Replay depends on this: a fresh id per run would remount every card.
    const first = episodeFromItem(ITEM, "https://example.com/feed.xml", "Show", 0);
    const again = episodeFromItem(ITEM, "https://example.com/feed.xml", "Show", 0);
    expect(first?.id).toBe(again?.id);
    expect(stableEpisodeId("a", "b")).not.toBe(stableEpisodeId("a", "c"));
  });

  test("requires BOTH a parseable feed and an enclosure to call it a podcast", () => {
    const withAudio =
      '<rss><channel><item><title>E</title><enclosure url="https://a.test/a.mp3"/></item></channel></rss>';
    expect(looksLikePodcastFeed(withAudio)).toBe(true);
    // A blog feed: a real feed, but nothing to transcribe.
    expect(
      looksLikePodcastFeed("<rss><channel><item><title>Post</title></item></channel></rss>"),
    ).toBe(false);
    expect(looksLikePodcastFeed("<html></html>")).toBe(false);
  });

  test("an ATOM podcast feed counts, which the `<rss` test refused outright", () => {
    const atom =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Show</title>' +
      '<entry><title>E</title><enclosure url="https://a.test/a.mp3"/></entry></feed>';
    expect(looksLikePodcastFeed(atom)).toBe(true);
  });

  test("finds an advertised feed in either attribute order, and resolves it", () => {
    const hrefFirst = '<link href="/feed.xml" type="application/rss+xml">';
    const typeFirst = '<link type="application/rss+xml" href="/feed.xml">';
    for (const html of [hrefFirst, typeFirst]) {
      expect(discoverFeedUrl(html, "https://example.com/show")).toBe(
        "https://example.com/feed.xml",
      );
    }
    expect(discoverFeedUrl("<html></html>", "https://example.com/show")).toBeUndefined();
  });

  test("extracts an Apple feed URL, and only for the show that was asked for", () => {
    const html =
      '<script id="serialized-server-data">' +
      '{"data":[{"model":{"adamId":"999","feedUrl":"https://other.test/feed"}},' +
      '{"model":{"adamId":"1473872585","title":"Apple News Today","feedUrl":"https://apple.test/feed"}}]}' +
      "</script>";
    expect(extractAppleSerializedFeed(html, "1473872585")).toEqual({
      feedUrl: "https://apple.test/feed",
      title: "Apple News Today",
    });
    expect(extractAppleSerializedFeed(html, "0000")).toBeUndefined();
  });

  test("survives a page with no serialized blob, or an unparseable one", () => {
    expect(extractAppleSerializedFeed("<html></html>", "1")).toBeUndefined();
    expect(
      extractAppleSerializedFeed('<script id="serialized-server-data">{not json</script>', "1"),
    ).toBeUndefined();
  });

  test("refuses a Spotify match that is merely a near neighbour", () => {
    expect(titleMatchesSpotify("The Daily", "The New York Times", { title: "The Daily" })).toBe(
      true,
    );
    expect(
      titleMatchesSpotify("The Daily", "The New York Times", {
        title: "The Daily",
        artist: "The New York Times",
      }),
    ).toBe(true);
    // A different show whose title merely resembles it.
    expect(
      titleMatchesSpotify("The Daily", "The New York Times", { title: "Daily Tech News" }),
    ).toBe(false);
    expect(titleMatchesSpotify("The Daily", "", {})).toBe(false);
  });
});

describe("the digest as a channel message", () => {
  /**
   * What is left to test here after the channel concept landed: the MESSAGE,
   * not the payload. Slack's two webhook shapes, the Block Kit assembly, the
   * mrkdwn escaping and the advice each refusal deserves are
   * `@alexkroman1/aai/channels`' and are covered by its own specs — a template
   * asserting them again would pin the SDK's rendering from the outside, which
   * is exactly the duplication moving them was for.
   */
  test("carries every episode as its own section, linked and attributed", () => {
    const message = renderDigestMessage(slackInput("https://hooks.slack.com/services/T/B/a"));

    expect(message.heading).toBe("Podcast digest 1/2");
    expect(message.subtitle).toContain("Feeds:");
    expect(message.sections).toHaveLength(1);
    expect(message.sections?.[0]).toMatchObject({
      title: "Example Episode",
      subtitle: "Example Podcast",
      body: "A concise episode summary.",
      bullets: ["First point", "Second point"],
    });
    expect(message.sections?.[0]?.url).toContain("http");
  });

  /**
   * `text` is the notification line, and on a Slack workflow trigger it is the
   * WHOLE message — so it has to stand on its own rather than repeat the
   * heading a trigger will never render.
   */
  test("says how much arrived in the notification line", () => {
    const message = renderDigestMessage(slackInput("https://hooks.slack.com/triggers/T/B/a"));

    expect(message.text).toBe("Podcast digest 1/2: 1 episode summaries");
  });
});

describe("the repeat schedule", () => {
  test("prints an interval a person can read, singular at one", () => {
    expect(formatScheduleInterval(1, "hours")).toBe("1 hour");
    expect(formatScheduleInterval(15, "minutes")).toBe("15 minutes");
    expect(formatScheduleInterval(2, "days")).toBe("2 days");
  });

  test("converts an interval to the milliseconds a durable sleep takes", () => {
    expect(scheduleIntervalMs(15, "minutes")).toBe(900_000);
    expect(scheduleIntervalMs(6, "hours")).toBe(21_600_000);
    expect(scheduleIntervalMs(2, "days")).toBe(172_800_000);
  });
});

// ---- The steps ---------------------------------------------------------------

/**
 * A feed body. `looksLikePodcastFeed` wants BOTH an `<rss` root and an
 * `<enclosure url=`, so these fixtures carry both unless a case is about not.
 */
const feedXml = (items: string, title = "Example Show") =>
  `<?xml version="1.0"?><rss><channel><title>${title}</title>${items}</channel></rss>`;

const itemXml = (title: string, pubDate: string, audio = `https://cdn.test/${title}.mp3`) =>
  `<item><title>${title}</title><link>https://show.test/${title}</link>` +
  `<guid>${title}</guid><pubDate>${pubDate}</pubDate>` +
  `<enclosure url="${audio}" type="audio/mpeg"/></item>`;

const THREE_EPISODES = feedXml(
  itemXml("oldest", "Tue, 01 Jan 2030 00:00:00 GMT") +
    itemXml("newest", "Thu, 03 Jan 2030 00:00:00 GMT") +
    itemXml("middle", "Wed, 02 Jan 2030 00:00:00 GMT"),
);

/**
 * Route by URL, so one stub can answer a whole resolution chain.
 *
 * `installStubStepFetch` unpublishes on `onTestFinished`, which is why no
 * describe block below keeps a `restore` of its own — a hand-kept registry is
 * the thing that forgets, and a step fetch left published reaches the next file.
 */
function stubRoutes(routes: Record<string, { status?: number; body?: unknown }>) {
  return installStubStepFetch((request) => {
    for (const [fragment, answer] of Object.entries(routes)) {
      if (request.url.includes(fragment)) return answer;
    }
    return { status: 404, body: `no route for ${request.url}` };
  });
}

describe("discoverEpisodes", () => {
  const stub = stubRoutes;

  test("reads a feed URL directly and returns the newest episodes first", async () => {
    const stubbed = stub({ "show.test/feed.xml": { body: THREE_EPISODES } });

    const episodes = await discoverEpisodes("https://show.test/feed.xml", 10);

    // Once. Deciding it is a feed and reading it are the same download.
    expect(stubbed.calls).toHaveLength(1);

    expect(episodes.map((episode) => episode.title)).toEqual(["newest", "middle", "oldest"]);
    expect(episodes[0]?.podcastTitle).toBe("Example Show");
    expect(episodes[0]?.audioUrl).toBe("https://cdn.test/newest.mp3");
  });

  test("keeps only maxEpisodes, counted after the sort", async () => {
    stub({ "show.test/feed.xml": { body: THREE_EPISODES } });

    const episodes = await discoverEpisodes("https://show.test/feed.xml", 2);

    // The NEWEST two — a slice taken before sorting would give feed order.
    expect(episodes.map((episode) => episode.title)).toEqual(["newest", "middle"]);
  });

  test("merges several feeds and deduplicates the links first", async () => {
    stub({
      "one.test/feed.xml": { body: feedXml(itemXml("a", "Tue, 01 Jan 2030 00:00:00 GMT"), "One") },
      "two.test/feed.xml": { body: feedXml(itemXml("b", "Wed, 02 Jan 2030 00:00:00 GMT"), "Two") },
    });

    const episodes = await discoverEpisodes(
      "https://one.test/feed.xml, https://two.test/feed.xml, https://one.test/feed.xml",
      10,
    );

    expect(episodes.map((episode) => episode.podcastTitle)).toEqual(["Two", "One"]);
  });

  test("follows a page that advertises a feed, and verifies what it finds", async () => {
    const stubbed = stub({
      "show.test/home": { body: '<html><link type="application/rss+xml" href="/feed.xml"></html>' },
      "show.test/feed.xml": { body: THREE_EPISODES },
    });

    expect(await discoverEpisodes("https://show.test/home", 1)).toHaveLength(1);
    // Verified, not trusted — the advertised URL is fetched before it is used.
    // And fetched ONCE: the verified body is carried into the reader rather
    // than the identical document being downloaded again.
    expect(stubbed.calls.map((call) => call.url)).toEqual([
      "https://show.test/home",
      "https://show.test/feed.xml",
    ]);
  });

  test("refuses a page that advertises a feed with no audio in it", async () => {
    // Plenty of pages point `application/rss+xml` at a blog feed.
    stub({
      "show.test/home": { body: '<html><link type="application/rss+xml" href="/blog.xml"></html>' },
      "show.test/blog.xml": {
        body: "<rss><channel><item><title>Post</title></item></channel></rss>",
      },
    });

    await expect(discoverEpisodes("https://show.test/home", 1)).rejects.toThrow(
      /does not look like a podcast RSS feed/,
    );
  });

  test("says what to paste when a page advertises nothing", async () => {
    stub({ "show.test/home": { body: "<html><body>hello</body></html>" } });

    await expect(discoverEpisodes("https://show.test/home", 1)).rejects.toThrow(
      /Could not find a podcast RSS feed/,
    );
  });

  test("resolves an Apple Podcasts link through the lookup API", async () => {
    stub({
      "itunes.apple.com/lookup": {
        body: {
          results: [{ feedUrl: "https://show.test/feed.xml", collectionName: "Example Show" }],
        },
      },
      "show.test/feed.xml": { body: THREE_EPISODES },
    });

    const episodes = await discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 1);

    expect(episodes[0]?.podcastTitle).toBe("Example Show");
  });

  /**
   * The three degradation cases of the iTunes payload, which is third-party
   * JSON reached without an API key — so every one of them is a shape a live
   * run really meets, and NONE of them may fail the run. A schema parsed with a
   * throwing `parse` fails all three.
   */
  test("keeps the usable hit when a neighbouring entry is not even an object", async () => {
    stub({
      "itunes.apple.com/lookup": {
        body: {
          results: [
            "no results",
            7,
            null,
            { feedUrl: "https://show.test/feed.xml", collectionName: "Example Show" },
          ],
        },
      },
      "show.test/feed.xml": { body: THREE_EPISODES },
    });

    const episodes = await discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 1);

    expect(episodes[0]?.podcastTitle).toBe("Example Show");
  });

  test("reads a malformed lookup payload as no hits, and takes the other route", async () => {
    // An interstitial, a rate-limit body, a schema change: `results` is not an
    // array, so there is nothing to search — which is what the page fallback
    // below this exists for, and is a normal outcome rather than a failed run.
    stub({
      "itunes.apple.com/lookup": { body: { results: "temporarily unavailable" } },
      "podcasts.apple.com": {
        body:
          '<script id="serialized-server-data">' +
          '{"d":[{"model":{"adamId":"123","feedUrl":"https://show.test/feed.xml"}}]}' +
          "</script>",
      },
      "show.test/feed.xml": { body: THREE_EPISODES },
    });

    expect(await discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 1)).toHaveLength(
      1,
    );
  });

  test("falls back to the feed's host when the hit names the show unusably", async () => {
    // `collectionName` of the wrong type and no `trackName` behind it is the
    // same case as neither field being there: the hit still carries the one
    // field the caller came for, so it is used, and the title falls back to the
    // feed's host. The feed here has no `<title>` of its own, which is what
    // makes that fallback observable at all.
    stub({
      "itunes.apple.com/lookup": {
        body: { results: [{ feedUrl: "https://show.test/feed.xml", collectionName: 42 }] },
      },
      "show.test/feed.xml": {
        body: `<?xml version="1.0"?><rss><channel>${itemXml("only", "Tue, 01 Jan 2030 00:00:00 GMT")}</channel></rss>`,
      },
    });

    const episodes = await discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 1);

    expect(episodes[0]?.podcastTitle).toBe("show.test");
  });

  test("falls back to Apple's own page when the lookup omits the feed", async () => {
    stub({
      "itunes.apple.com/lookup": { body: { results: [{ collectionName: "Example Show" }] } },
      "podcasts.apple.com": {
        body:
          '<script id="serialized-server-data">' +
          '{"d":[{"model":{"adamId":"123","title":"Example Show","feedUrl":"https://show.test/feed.xml"}}]}' +
          "</script>",
      },
      "show.test/feed.xml": { body: THREE_EPISODES },
    });

    expect(await discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 1)).toHaveLength(
      1,
    );
  });

  test("gives up on an Apple show with no public feed anywhere", async () => {
    stub({
      "itunes.apple.com/lookup": { body: { results: [] } },
      "podcasts.apple.com": { body: "<html></html>" },
    });

    await expect(
      discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 1),
    ).rejects.toThrow(/did not expose a public RSS feed/);
  });

  test("maps a Spotify show to a feed through Apple's search", async () => {
    stub({
      "open.spotify.com": {
        body:
          '<html><meta property="og:title" content="Example Show">' +
          '<meta property="og:description" content="A show about examples"></html>',
      },
      "itunes.apple.com/search": {
        body: {
          results: [{ feedUrl: "https://show.test/feed.xml", collectionName: "Example Show" }],
        },
      },
      "show.test/feed.xml": { body: THREE_EPISODES },
    });

    expect(await discoverEpisodes("https://open.spotify.com/show/abc", 1)).toHaveLength(1);
  });

  /** Silently digesting a neighbouring show is the failure nobody reports. */
  test("refuses a Spotify search hit that is a different show", async () => {
    stub({
      "open.spotify.com": {
        body: '<html><meta property="og:title" content="Example Show"></html>',
      },
      "itunes.apple.com/search": {
        body: {
          results: [{ feedUrl: "https://other.test/feed.xml", collectionName: "Something Else" }],
        },
      },
    });

    await expect(discoverEpisodes("https://open.spotify.com/show/abc", 1)).rejects.toThrow(
      /Could not map the Spotify show/,
    );
  });

  test("asks for a link rather than failing obscurely on an empty list", async () => {
    stub({});
    await expect(discoverEpisodes("   ", 1)).rejects.toThrow(/Add at least one podcast link/);
  });

  test("names the four accepted shapes when a feed carries no episode audio", async () => {
    // Reached through APPLE, which resolves a feed URL from the lookup API and
    // does not run it past `looksLikePodcastFeed` — so this is the one route
    // left to a feed that resolves and yields nothing, and the case a bare "no
    // episodes" would not explain. The plain-web route can no longer get here:
    // the predicate asks whether some ITEM carries audio, which is the same
    // question `readPodcastFeed` filters on, so a text-only feed is refused
    // earlier with a message that names the URL.
    stub({
      "itunes.apple.com/lookup": {
        body: { results: [{ feedUrl: "https://show.test/feed.xml", collectionName: "T" }] },
      },
      "show.test/feed.xml": {
        body: "<rss><channel><title>T</title><item><title>No audio</title></item></channel></rss>",
      },
    });

    await expect(
      discoverEpisodes("https://podcasts.apple.com/us/podcast/x/id123", 5),
    ).rejects.toThrow(
      /Apple Podcasts show link, a Spotify show link, an RSS feed URL, or a podcast homepage/,
    );
  });

  test("a text-only feed pasted directly is refused by NAME, not as an empty digest", async () => {
    // The other half of the change above: this used to reach the generic "no
    // episodes" message, and now names the URL the person actually pasted.
    stub({
      "show.test/feed.xml": {
        body: "<rss><channel><title>T</title><item><title>No audio</title></item></channel></rss>",
      },
    });

    await expect(discoverEpisodes("https://show.test/feed.xml", 5)).rejects.toThrow(
      /Could not find a podcast RSS feed at https:\/\/show\.test\/feed\.xml/,
    );
  });

  test("propagates a feed that will not load, so the run can retry it", async () => {
    stub({ "show.test/feed.xml": { status: 503, body: "busy" } });
    await expect(discoverEpisodes("https://show.test/feed.xml", 1)).rejects.toThrow(/503/);
  });
});

describe("transcribing one episode", () => {
  beforeEach(() => vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key"));

  const stub = stubRoutes;

  const EPISODE_IN = {
    id: "episode-1",
    feedUrl: "https://show.test/feed.xml",
    podcastTitle: "Example Show",
    title: "An Episode",
    url: "https://show.test/ep",
    audioUrl: "https://cdn.test/a.mp3",
    published: "Thu, 03 Jan 2030 00:00:00 GMT",
  };

  test("submits the audio and keeps the id the rest of the run polls", async () => {
    stub({ "/v2/transcript": { body: { id: "t-1" } } });

    expect(await submitTranscript(EPISODE_IN)).toMatchObject({
      transcriptStatus: "submitted",
      transcriptId: "t-1",
    });
  });

  /** The partial-failure policy: this-episode-is-broken degrades, it does not throw. */
  test("degrades a terminal submit failure to an unavailable episode", async () => {
    stub({ "/v2/transcript": { status: 400, body: { error: "audio_url is not reachable" } } });

    const job = await submitTranscript(EPISODE_IN);

    expect(job.transcriptStatus).toBe("unavailable");
    expect(job).toMatchObject({ reason: expect.stringContaining("audio_url") });
  });

  /** The other half: a transport problem is the DevKit's to retry. */
  test("re-throws a retryable submit failure instead of degrading it", async () => {
    stub({ "/v2/transcript": { status: 503, body: "busy" } });
    await expect(submitTranscript(EPISODE_IN)).rejects.toThrow();
  });

  test("returns the job unchanged while the provider is still working", async () => {
    stub({ "/v2/transcript/t-1": { body: { status: "processing" } } });
    const job = { ...EPISODE_IN, transcriptStatus: "submitted" as const, transcriptId: "t-1" };

    // Unchanged, so `waitForTranscripts` can keep it in `pending` without a
    // second vocabulary for "still going".
    expect(await pollTranscript(job)).toBe(job);
  });

  test("reads the transcript once the provider is done", async () => {
    stub({
      "/v2/transcript/t-1": {
        body: { status: "completed", text: "Otters use tools.", audio_duration: 61 },
      },
    });

    expect(
      await pollTranscript({ ...EPISODE_IN, transcriptStatus: "submitted", transcriptId: "t-1" }),
    ).toMatchObject({ transcriptStatus: "done", transcript: "Otters use tools." });
  });

  test("degrades a job the provider gave up on", async () => {
    stub({ "/v2/transcript/t-1": { body: { status: "error", error: "corrupt media" } } });

    expect(
      await pollTranscript({ ...EPISODE_IN, transcriptStatus: "submitted", transcriptId: "t-1" }),
    ).toMatchObject({
      transcriptStatus: "unavailable",
      reason: expect.stringContaining("corrupt"),
    });
  });

  test("passes an already-unavailable episode straight through without a request", async () => {
    const stubbed = stub({});
    const job = { ...EPISODE_IN, transcriptStatus: "unavailable" as const, reason: "no audio" };

    expect(await pollTranscript(job)).toBe(job);
    expect(stubbed.calls).toHaveLength(0);
  });

  test("summarizes a finished transcript into the digest entry", async () => {
    stubGateway('{"summary":"Otters are clever.","keyPoints":["They use tools","They float"]}');

    expect(
      await summarizeTranscript({
        ...EPISODE_IN,
        transcriptStatus: "done",
        transcriptId: "t-1",
        transcript: "Otters use tools.",
        durationMs: 61_000,
      }),
    ).toMatchObject({
      transcriptSource: "assemblyai",
      summary: "Otters are clever.",
      keyPoints: ["They use tools", "They float"],
    });
  });

  /** One bad episode must not sink a digest of five. */
  test("still produces an entry for an episode that could not be transcribed", async () => {
    const digest = await summarizeTranscript({
      ...EPISODE_IN,
      transcriptStatus: "unavailable",
      reason: "corrupt media",
    });

    expect(digest.transcriptSource).toBe("unavailable");
    // The reason reaches the reader, rather than the episode vanishing.
    expect(digest.summary).toContain("corrupt media");
    expect(digest.keyPoints).toHaveLength(1);
  });

  test("reads the clock in a step, so a replay sees the same timestamp", async () => {
    expect(Date.parse(await timestamp())).not.toBeNaN();
  });
});

describe("posting the digest", () => {
  const stub = (answer: { status?: number; body?: unknown }) => installStubStepFetch(() => answer);

  const INPUT = slackInput("https://hooks.slack.com/services/T/B/a");

  test("posts the rendered payload and answers with what Slack said", async () => {
    const stubbed = stub({ body: "ok" });

    expect(await sendDigestToSlack(INPUT)).toBe("ok");
    expect(stubbed.calls[0]?.method).toBe("POST");
    expect(String(stubbed.calls[0]?.body)).toContain("Podcast digest 1/2");
  });

  test("treats an empty 200 as success rather than an empty status", async () => {
    stub({ body: "" });
    expect(await sendDigestToSlack(INPUT)).toBe("ok");
  });

  /**
   * The 4xx/5xx split is the reason this is not a one-line `stepFetchOk`: a
   * revoked webhook answers 4xx identically on every retry, so retrying it
   * burns the DevKit's attempts and delays the real error by minutes.
   */
  test("makes a 4xx FATAL, with advice a person can act on", async () => {
    stub({ status: 403, body: { error: "invalid_token" } });

    await expect(sendDigestToSlack(INPUT)).rejects.toThrow(/revoked/);
  });

  test("names the unpublished workflow behind a trigger URL", async () => {
    stub({ status: 400, body: { error: "workflow_not_published" } });

    await expect(
      sendDigestToSlack(slackInput("https://hooks.slack.com/triggers/T/B/a")),
    ).rejects.toThrow(/not published/);
  });

  test("leaves a 5xx retryable, because that is Slack having a bad minute", async () => {
    stub({ status: 503, body: "busy" });

    const err = await sendDigestToSlack(INPUT).catch((thrown: unknown) => thrown);

    expect((err as Error).message).toContain("503");
    // NOT fatal — a `FatalError` here would drop a digest over a blip.
    expect((err as Error).name).not.toBe("FatalError");
  });
});

describe("the body — the run that IS the schedule", () => {
  /**
   * The body driven end to end with no I/O.
   *
   * `runSteps: false` plus a skeleton of results: what this pins is the body's
   * own logic — the digest loop, the shrinking pending set in
   * `waitForTranscripts`, and the sleep between digests — none of which any
   * per-step spec can see, and all of which is the template's actual subject.
   */
  function driveTwoDigests(pollResults: unknown) {
    const ctx = createWorkflowCtx({
      runSteps: false,
      results: {
        discoverEpisodes: [EPISODE],
        submitTranscript: { id: EPISODE.id, transcriptId: "t_1" },
        pollTranscript: pollResults,
        summarizeTranscript: EPISODE,
        postDigest: { ok: true },
        timestamp: "2026-08-21T00:00:00.000Z",
      },
    });
    return { ctx };
  }

  test("sends one digest per interval and sleeps BETWEEN them, never after the last", async () => {
    // A run that has delivered everything it owes should end, not sleep for a
    // day and then end.
    const { ctx } = driveTwoDigests({
      id: EPISODE.id,
      transcriptStatus: "completed",
      transcript: "words",
    });

    const output = await dailyDigestFlow(
      {
        ...VALID,
        slackWorkflowTextParam: "text",
        daysToRun: 2,
        maxEpisodesPerDigest: 1,
        intervalEvery: 2,
        intervalUnit: "hours",
      },
      ctx,
    );

    expect(output.digestsSent).toBe(2);
    expect(output.digestsScheduled).toBe(2);
    // Two digests, ONE sleep.
    expect(ctx.slept).toHaveLength(1);
    expect(ctx.slept[0]?.until).toBe(scheduleIntervalMs(2, "hours"));
    expect(ctx.steps.filter((step) => step.name === "postDigest")).toHaveLength(2);
  });

  test("reports the last digest it actually sent", async () => {
    const { ctx } = driveTwoDigests({
      id: EPISODE.id,
      transcriptStatus: "completed",
      transcript: "words",
    });

    const output = await dailyDigestFlow(
      {
        ...VALID,
        slackWorkflowTextParam: "text",
        daysToRun: 1,
        maxEpisodesPerDigest: 1,
        intervalEvery: 1,
        intervalUnit: "days",
      },
      ctx,
    );

    expect(output.lastDigest).toMatchObject({
      sentAt: "2026-08-21T00:00:00.000Z",
      episodes: [EPISODE],
    });
    expect(ctx.slept).toEqual([]);
  });

  test("gives up on an episode that never finishes rather than failing the digest", async () => {
    // Running out of poll rounds is NOT an error: a partial digest beats none,
    // and the reason is printed where a reader will see it. The poll answers
    // `submitted` forever, so the loop exhausts its rounds.
    const { ctx } = driveTwoDigests({ id: EPISODE.id, transcriptStatus: "submitted" });

    const output = await dailyDigestFlow(
      {
        ...VALID,
        slackWorkflowTextParam: "text",
        daysToRun: 1,
        maxEpisodesPerDigest: 1,
        intervalEvery: 1,
        intervalUnit: "days",
      },
      ctx,
    );

    expect(output.digestsSent).toBe(1);
    // Every round slept except the last, which is what bounds the wait.
    expect(ctx.slept.length).toBeGreaterThan(0);
    for (const sleep of ctx.slept) expect(sleep.until).toBe(POLL_DELAY_MS);
  });
});

/**
 * The schedule, on the real replay engine.
 *
 * The block above drives the same body through `createWorkflowCtx`, which
 * RECORDS a sleep rather than taking one and replays nothing — right for the
 * loop's logic, and silent about the property this template is: a run that
 * sleeps for a day between digests and comes back. `runWorkflow`
 * (`@alexkroman1/aai-runtime/testing`) is the real engine over an in-memory
 * journal, so the run genuinely parks, genuinely resumes off its journal, and
 * genuinely does not redo the digest it already posted.
 *
 * Two sleeps are in play and they are different things, which is exactly what a
 * recorded one cannot show: the POLL cadence inside `waitForTranscripts`, and
 * the SCHEDULE interval between digests. Both are `ctx.sleep`, so both end with
 * `advanceSleep()` — the same call `ctx.workflows.wakeUp` makes.
 */
describe("the run is DURABLE", () => {
  const FEED = feedXml(itemXml("newest", "Thu, 03 Jan 2030 00:00:00 GMT"));
  const SUMMARY = '{"summary":"Otters are clever.","keyPoints":["They use tools","They float"]}';

  const SCHEDULE = {
    ...VALID,
    slackWorkflowTextParam: "text",
    maxEpisodesPerDigest: 1,
    intervalEvery: 2,
    intervalUnit: "hours" as const,
  };

  /**
   * The feed, the provider, the model and Slack, behind ONE published
   * `stepFetch`.
   *
   * Every step's HTTP goes through the slot, the model call included, so a
   * gateway stub over `globalThis.fetch` beside these routes would be bypassed.
   * `stubGatewayRoute` is the composition for it — the same note
   * `link-digest/agent.test.ts` carries.
   *
   * `polls` is how many `GET /v2/transcript/:id` answers say "not yet" before
   * the job is reported done, which is how a case decides whether the run has
   * to sit through the poll cadence at all.
   */
  function stubWorld({ polls = 0 }: { polls?: number } = {}) {
    const model = stubGatewayRoute(SUMMARY);
    const seen = { feeds: 0, submits: 0, slack: 0, polls: 0 };
    installStubStepFetch((request) => {
      const routed = model.route(request);
      if (routed) return routed;
      if (request.url.includes("hooks.slack.com")) {
        seen.slack += 1;
        return { status: 200, body: "ok" };
      }
      if (request.url.includes("/v2/transcript")) {
        if (request.method === "POST") {
          seen.submits += 1;
          return { status: 200, body: { id: "t_1", status: "queued" } };
        }
        seen.polls += 1;
        return seen.polls <= polls
          ? { status: 200, body: { id: "t_1", status: "processing" } }
          : { status: 200, body: { id: "t_1", status: "completed", text: "Otters use tools." } };
      }
      seen.feeds += 1;
      return { status: 200, body: FEED, headers: { "Content-Type": "application/xml" } };
    });
    return { model, seen };
  }

  beforeEach(() => vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key"));

  test("a one-digest run ends without sleeping, and posts once", async () => {
    // The negative half of the schedule claim, and the cheap one: a run that has
    // delivered everything it owes should END, not sleep for a day and then end.
    const world = stubWorld();
    const run = await runWorkflow(
      dailyDigest,
      { ...SCHEDULE, daysToRun: 1 },
      { name: "dailyDigest" },
    );

    expect(run.status).toBe("completed");
    expect(run.output?.digestsSent).toBe(1);
    expect(run.deliveries).toBe(1);
    expect(run.wakeAt).toBeUndefined();
    expect(world.seen.slack).toBe(1);
  });

  test("parks on the poll cadence, and the resume does not re-submit the episode", async () => {
    // The transcription is already paid for; a resume that submitted again would
    // buy it twice and get a different job id.
    const world = stubWorld({ polls: 1 });
    const run = await runWorkflow(
      dailyDigest,
      { ...SCHEDULE, daysToRun: 1 },
      { name: "dailyDigest" },
    );

    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThan(Date.now());
    expect(world.seen.submits).toBe(1);
    expect(run.steps.map((step) => step.key)).toEqual([
      "discoverEpisodes#0",
      "pollTranscript#0",
      "submitTranscript#0",
    ]);

    await run.advanceSleep();
    expect(run.status).toBe("completed");
    expect(run.output?.digestsSent).toBe(1);
    // ONE submit across two walks — the first is read back out of the journal.
    expect(world.seen.submits).toBe(1);
    expect(world.seen.polls).toBe(2);
  });

  test("sleeps the SCHEDULE between digests, then runs the second one", async () => {
    const world = stubWorld();
    const started = Date.now();
    const run = await runWorkflow(
      dailyDigest,
      { ...SCHEDULE, daysToRun: 2 },
      { name: "dailyDigest" },
    );

    // Digest one is posted and the run is parked on the interval — two hours,
    // which nothing here waits for.
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThanOrEqual(started + scheduleIntervalMs(2, "hours"));
    expect(world.seen.slack).toBe(1);
    expect(run.output).toBeUndefined();

    await run.advanceSleep();
    expect(run.status).toBe("completed");
    expect(run.output?.digestsSent).toBe(2);
    expect(run.deliveries).toBe(2);
    // TWO posts, and the second digest did its own discovery — the loop's second
    // turn is `discoverEpisodes#1`, a different journal entry from the first, so
    // a schedule really re-reads the feed rather than replaying yesterday's.
    expect(world.seen.slack).toBe(2);
    expect(run.steps.map((step) => step.key)).toContain("discoverEpisodes#1");
    // And digest one's post is NOT made a second time: one `postDigest` entry
    // per digest, both journaled.
    expect(run.steps.filter((step) => step.name === "postDigest")).toHaveLength(2);
  });

  test("a worker that dies before the digest is posted replays the transcription", async () => {
    // The expensive half. Transcribing and summarizing an episode is minutes of
    // provider time; a resume must reach Slack without paying for either again.
    const world = stubWorld();
    const run = await runWorkflow(
      dailyDigest,
      { ...SCHEDULE, daysToRun: 1 },
      { name: "dailyDigest", crashAt: "postDigest" },
    );

    expect(run.crashed).toBe(true);
    expect(world.seen.slack).toBe(0);
    expect(world.seen.submits).toBe(1);
    expect(world.model.calls).toHaveLength(1);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output?.digestsSent).toBe(1);
    expect(world.seen.slack).toBe(1);
    // Neither the provider nor the model was asked a second time.
    expect(world.seen.submits).toBe(1);
    expect(world.model.calls).toHaveLength(1);
  });
});
