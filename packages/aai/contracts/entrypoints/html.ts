// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `html`.
 *
 * Reading somebody else's markup from a step: markup to prose, a feed to its
 * entries, and the three things a scraper takes off a page's head.
 *
 * It is contracted — rather than left on `@alexkroman1/aai/internal` with the
 * uncovered infrastructure — because the SHAPE is the promise. A template's
 * digest walks `ParsedFeed.items` and reads `enclosureUrl` off each one, so
 * renaming a field or changing what `title` holds (text, as documented, rather
 * than the markup a feed wrapped in CDATA) breaks an author's body in a way no
 * runtime check catches. `htmlToText`'s OUTPUT is likewise part of it, for the
 * same reason the narration formatters on `utils` are: a step and a page can
 * both render it and must not disagree.
 *
 * `decodeHtmlEntities` stays on the `utils` capability and is not duplicated
 * here. The two answer different questions — six entities with no dependency,
 * for a browser bundle, against a parse for a Node step — and a name belongs to
 * exactly one contract.
 *
 * Re-exported from `@alexkroman1/aai/html`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type FeedItem,
  htmlToText,
  type PageMetadata,
  type ParsedFeed,
  pageMetadata,
  parseFeed,
} from "../../host/html.ts";
