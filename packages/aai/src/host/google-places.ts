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
 *
 * **"Near me" means the client's location when it reported one.** A session
 * opened with `?location=` (see `session-location.ts`) gets its address
 * resolved to coordinates once — a one-place `searchText` for the address
 * itself, so no second Google API needs enabling — and every search after
 * that sends them as a `locationBias`. A bias, not a restriction: a query
 * that names somewhere else ("pizza in Seattle") still finds Seattle.
 *
 * The same coordinates go in as the `routingParameters.origin`, so each place
 * comes back with its drive time and road distance from the caller — "how far
 * is the nearest Costco" is answered by the search itself, with no Routes API
 * call. `routingSummaries` bills at Google's Enterprise + Atmosphere tier, so
 * it is only requested when there is an origin (Google rejects it without one).
 */

import { z } from "zod";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ToolDef } from "../sdk/types.ts";
import { builtinCover } from "./_builtin-cover.ts";
import { fetchKeyedJson } from "./_keyed-api.ts";
import { type SessionCoords, sessionCoords } from "./session-location.ts";
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
/** How far the location bias reaches, in meters — "near" for a home speaker. */
const BIAS_RADIUS_M = 15_000;

/** Every per-place field this tool returns — and so every field Google bills for. */
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
/** Added to the mask only alongside an origin. */
const ROUTING_FIELD = "routingSummaries";
const METERS_PER_MILE = 1609.344;

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

/** One per place, index-aligned with `places`; one leg from the origin to it. */
const RoutingSummarySchema = z.object({
  legs: z
    .array(z.object({ duration: z.string().optional(), distanceMeters: z.number().optional() }))
    .optional(),
});

/** An empty result set is `{}`, not `{ places: [] }`. */
const SearchTextResponseSchema = z.object({
  places: z.array(PlaceSchema).optional(),
  routingSummaries: z.array(RoutingSummarySchema).optional(),
});

const LocateResponseSchema = z.object({
  places: z
    .array(z.object({ location: z.object({ latitude: z.number(), longitude: z.number() }) }))
    .optional(),
});

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

/** One decimal place: "2.3 miles" is what gets read out, not "2.2861 miles". */
const tenths = (n: number) => Math.round(n * 10) / 10;

/** A leg's `"597s"` and meters → whole drive minutes and miles/km, when Google gave them. */
function travel(summary: z.infer<typeof RoutingSummarySchema> | undefined) {
  const leg = summary?.legs?.[0];
  const seconds = leg?.duration?.match(/^(\d+(?:\.\d+)?)s$/)?.[1];
  const meters = leg?.distanceMeters;
  return {
    driveMinutes: seconds === undefined ? undefined : Math.max(1, Math.round(Number(seconds) / 60)),
    distanceMiles: meters === undefined ? undefined : tenths(meters / METERS_PER_MILE),
    distanceKm: meters === undefined ? undefined : tenths(meters / 1000),
  };
}

export function createGooglePlaces(
  fetchFn = builtinFetch(),
): ToolDef<typeof googlePlacesParams> & { guidance: string } {
  type Ctx = Parameters<typeof fetchKeyedJson>[0];
  const search = (ctx: Ctx, body: Record<string, unknown>, fieldMask: string) =>
    fetchKeyedJson(ctx, {
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
        "X-Goog-FieldMask": fieldMask,
      }),
      body: JSON.stringify(body),
      fetch: fetchFn,
    });

  // The address's own coordinates, or nothing: a lookup that fails only costs
  // the bias, never the search the caller asked for.
  const locate = async (ctx: Ctx, address: string): Promise<SessionCoords | undefined> => {
    const res = await search(ctx, { textQuery: address, pageSize: 1 }, "places.location");
    if (!res.ok) return;
    return LocateResponseSchema.safeParse(res.value).data?.places?.[0]?.location;
  };

  return {
    guidance:
      "Use google_places to find businesses or places and their address, phone number, " +
      "hours, and rating. Include the area in the query when the caller gave one; for " +
      "something nearby, leave the area out — results favor the caller's own location, " +
      "and then each place also says how far it is and how long the drive takes.",
    description:
      "Search Google Places for businesses, landmarks, or addresses matching a text query. " +
      "Returns each place's name, address, phone number, rating, price level, whether it is " +
      "open now, weekly hours, website, and a Google Maps link, where Google has them — " +
      "plus driving minutes and distance from the caller when their location is known.",
    inputSchema: googlePlacesParams,
    messages: builtinCover("I'm searching for places."),
    async execute(args, ctx) {
      const count = Math.max(1, Math.min(args.max_results ?? 5, MAX_PLACES));
      const center = await sessionCoords(ctx, (address) => locate(ctx, address));
      const res = await search(
        ctx,
        // `openNow` only when asked: false and absent mean the same, and the
        // request stays the minimal one.
        {
          textQuery: args.query,
          pageSize: count,
          openNow: args.open_now || undefined,
          locationBias: center && { circle: { center, radius: BIAS_RADIUS_M } },
          routingParameters: center && { origin: center, travelMode: "DRIVE" },
        },
        center ? `${FIELD_MASK},${ROUTING_FIELD}` : FIELD_MASK,
      );
      if (!res.ok) return { error: res.error };
      const parsed = SearchTextResponseSchema.safeParse(res.value);
      if (!parsed.success) return { error: "Google Places response had an unexpected shape" };
      // Absent fields are dropped rather than sent as `undefined`, so the model
      // never reads a key with nothing behind it.
      const routes = parsed.data.routingSummaries;
      return (parsed.data.places ?? []).slice(0, count).map((p, i) =>
        omitUndefined({
          name: p.displayName?.text,
          type: p.primaryTypeDisplayName?.text,
          address: p.formattedAddress,
          ...travel(routes?.[i]),
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
