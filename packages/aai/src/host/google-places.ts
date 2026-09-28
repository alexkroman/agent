// Copyright 2026 the AAI authors. MIT license.
/**
 * The `google_places` builtin — find businesses and places with the Google
 * Places API (New) text search, for an agent that brings its own
 * `GOOGLE_PLACES_API_KEY`.
 *
 * One request, `POST places:searchText`, because the API has no GET form for a
 * free-text query and a caller's "a pharmacy open now near Union Square" IS a
 * free-text query. The field mask is fixed here rather than chosen by the
 * model: Google bills by the fields requested, so the set below — contact
 * details, rating, price level, hours — is a cost decision this module makes
 * once, and it is the set a voice agent actually reads out.
 *
 * The key handling — agent env only, not derived into `requiredEnv` — is
 * `_keyed-api.ts`'s, shared with `brave_search`.
 */

import { z } from "zod";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ToolDef } from "../sdk/types.ts";
import { fetchKeyedJson } from "./_keyed-api.ts";
import { builtinFetch } from "./ssrf.ts";

/** The agent-env variable `google_places` reads its API key from. */
export const GOOGLE_PLACES_API_KEY_ENV = "GOOGLE_PLACES_API_KEY";

const googlePlacesParams = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What to find and where, in plain words, e.g. 'pizza near Union Square San Francisco' " +
        "or 'Walgreens on Main Street, Springfield IL'",
    ),
  max_results: z.number().describe("Maximum number of places to return (default 5)").optional(),
  open_now: z.boolean().describe("Only return places open right now").optional(),
});

const SEARCH_TEXT_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const MAX_PLACES = 10;

/** Every field this tool returns — and so every field Google bills for. */
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.businessStatus",
  "places.primaryTypeDisplayName",
  "places.currentOpeningHours.openNow",
  "places.regularOpeningHours.weekdayDescriptions",
  "places.websiteUri",
  "places.googleMapsUri",
].join(",");

const PlaceSchema = z.object({
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  priceLevel: z.string().optional(),
  businessStatus: z.string().optional(),
  primaryTypeDisplayName: z.object({ text: z.string() }).optional(),
  currentOpeningHours: z.object({ openNow: z.boolean().optional() }).optional(),
  regularOpeningHours: z.object({ weekdayDescriptions: z.array(z.string()).optional() }).optional(),
  websiteUri: z.string().optional(),
  googleMapsUri: z.string().optional(),
});

/** An empty result set is `{}`, not `{ places: [] }`. */
const SearchTextResponseSchema = z.object({ places: z.array(PlaceSchema).optional() });

/** `PRICE_LEVEL_MODERATE` → `moderate`; the enum prefix is noise to the model. */
function priceLevel(level: string | undefined): string | undefined {
  if (!level || level === "PRICE_LEVEL_UNSPECIFIED") return undefined;
  return level
    .replace(/^PRICE_LEVEL_/, "")
    .toLowerCase()
    .replace(/_/g, " ");
}

/** `CLOSED_TEMPORARILY` → `closed temporarily`, and nothing for an operating place. */
function closure(status: string | undefined): string | undefined {
  if (!status || status === "OPERATIONAL" || status === "BUSINESS_STATUS_UNSPECIFIED") {
    return undefined;
  }
  return status.toLowerCase().replace(/_/g, " ");
}

export function createGooglePlaces(
  fetchFn = builtinFetch(),
): ToolDef<typeof googlePlacesParams> & { guidance: string } {
  return {
    guidance:
      "Use google_places to find businesses or places and their address, phone number, " +
      "hours, and rating. Include the area in the query when the caller gave one.",
    description:
      "Search Google Places for businesses, landmarks, or addresses matching a text query. " +
      "Returns each place's name, address, phone number, rating, price level, whether it is " +
      "open now, weekly hours, website, and a Google Maps link, where Google has them.",
    inputSchema: googlePlacesParams,
    async execute(args, ctx) {
      const count = Math.max(1, Math.min(args.max_results ?? 5, MAX_PLACES));
      const res = await fetchKeyedJson(ctx, {
        service: "Google Places",
        keyEnv: GOOGLE_PLACES_API_KEY_ENV,
        keyHint: "has the Places API (New) enabled",
        // Google answers an invalid key with 400 API_KEY_INVALID; the body is
        // not read, so it is named by status.
        rejectedStatuses: [400],
        url: SEARCH_TEXT_ENDPOINT,
        headers: (key) => ({
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": FIELD_MASK,
        }),
        // `openNow` only when asked: false and absent mean the same, and the
        // request stays the minimal one.
        body: JSON.stringify({
          textQuery: args.query,
          pageSize: count,
          openNow: args.open_now || undefined,
        }),
        fetch: fetchFn,
      });
      if (!res.ok) return { error: res.error };
      const parsed = SearchTextResponseSchema.safeParse(res.value);
      if (!parsed.success) return { error: "Google Places response had an unexpected shape" };
      // Absent fields are dropped rather than sent as `undefined`, so the model
      // never reads a key with nothing behind it.
      return (parsed.data.places ?? []).slice(0, count).map((p) =>
        omitUndefined({
          name: p.displayName?.text,
          type: p.primaryTypeDisplayName?.text,
          address: p.formattedAddress,
          phone: p.nationalPhoneNumber,
          rating: p.rating,
          ratingCount: p.userRatingCount,
          priceLevel: priceLevel(p.priceLevel),
          status: closure(p.businessStatus),
          openNow: p.currentOpeningHours?.openNow,
          hours: p.regularOpeningHours?.weekdayDescriptions,
          website: p.websiteUri,
          mapsUrl: p.googleMapsUri,
        }),
      );
    },
  };
}
