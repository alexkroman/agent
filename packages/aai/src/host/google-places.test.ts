// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext, fakeFetch } from "./_test-utils.ts";
import { createGooglePlaces } from "./google-places.ts";
import { setSessionLocation } from "./session-location.ts";

const placesBody = {
  places: [
    {
      displayName: { text: "Tony's Pizza", languageCode: "en" },
      primaryTypeDisplayName: { text: "Pizza restaurant" },
      formattedAddress: "1570 Stockton St, San Francisco, CA 94133, USA",
      nationalPhoneNumber: "(415) 835-9888",
      rating: 4.6,
      userRatingCount: 5123,
      priceLevel: "PRICE_LEVEL_MODERATE",
      businessStatus: "OPERATIONAL",
      currentOpeningHours: { openNow: true },
      regularOpeningHours: { weekdayDescriptions: ["Monday: 12:00 – 10:00 PM"] },
      websiteUri: "https://example.com/tonys",
      googleMapsUri: "https://maps.google.com/?cid=1",
    },
    {
      displayName: { text: "Closed Slice" },
      formattedAddress: "1 Main St",
      businessStatus: "CLOSED_TEMPORARILY",
    },
  ],
};

const withKey = () => createMockToolContext({ env: { GOOGLE_PLACES_API_KEY: "places-test-key" } });

function placesFetch(response: Response) {
  return vi.fn((_url: string, _init: RequestInit) => Promise.resolve(response));
}

describe("google_places", () => {
  test("POSTs a text search with the key and a fixed field mask, and flattens the result", async () => {
    const mockFetch = placesFetch(Response.json(placesBody));
    const result = await createGooglePlaces(fakeFetch(mockFetch)).execute(
      { query: "pizza in North Beach", open_now: true },
      withKey(),
    );
    expect(result).toEqual([
      {
        name: "Tony's Pizza",
        type: "Pizza restaurant",
        address: "1570 Stockton St, San Francisco, CA 94133, USA",
        phone: "(415) 835-9888",
        rating: 4.6,
        ratingCount: 5123,
        priceLevel: "moderate",
        openNow: true,
        hours: ["Monday: 12:00 – 10:00 PM"],
        website: "https://example.com/tonys",
        mapsUrl: "https://maps.google.com/?cid=1",
      },
      // Absent fields are dropped, and a non-operating status is surfaced.
      { name: "Closed Slice", address: "1 Main St", status: "closed temporarily" },
    ]);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      textQuery: "pizza in North Beach",
      pageSize: 5,
      openNow: true,
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("places-test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Goog-FieldMask"]).toContain("places.displayName");
    expect(headers["X-Goog-FieldMask"]).toContain("places.nationalPhoneNumber");
    // No origin, so no routing: Google rejects routingSummaries without one.
    expect(headers["X-Goog-FieldMask"]).not.toContain("routingSummaries");
  });

  test("max_results is clamped and openNow is omitted unless asked", async () => {
    const mockFetch = placesFetch(Response.json(placesBody));
    await createGooglePlaces(fakeFetch(mockFetch)).execute(
      { query: "q", max_results: 99 },
      withKey(),
    );
    expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body))).toEqual({
      textQuery: "q",
      pageSize: 10,
    });
  });

  test("no matches (`{}`) is zero results, not an error", async () => {
    const mockFetch = placesFetch(Response.json({}));
    const result = await createGooglePlaces(fakeFetch(mockFetch)).execute(
      { query: "q" },
      withKey(),
    );
    expect(result).toEqual([]);
  });

  test("no key in the agent env is an error naming the variable, and nothing is fetched", async () => {
    const mockFetch = placesFetch(Response.json(placesBody));
    const result = await createGooglePlaces(fakeFetch(mockFetch)).execute(
      { query: "q" },
      createMockToolContext(),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("Missing GOOGLE_PLACES_API_KEY"),
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a rejected key is named as the fix", async () => {
    const mockFetch = placesFetch(new Response("", { status: 403, statusText: "Forbidden" }));
    const result = await createGooglePlaces(fakeFetch(mockFetch)).execute(
      { query: "q" },
      withKey(),
    );
    expect(result).toEqual({
      error:
        "Google Places rejected GOOGLE_PLACES_API_KEY (403 Forbidden) — check the key is valid and has the Places API (New) enabled",
    });
  });

  test("a session's reported location is resolved once and sent as bias and routing origin", async () => {
    const located = { places: [{ location: { latitude: 45.56, longitude: -122.55 } }] };
    const routed = {
      ...placesBody,
      routingSummaries: [{ legs: [{ duration: "597s", distanceMeters: 2607 }] }, {}],
    };
    const mockFetch = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Promise.resolve(
        Response.json(body.pageSize === 1 && !body.locationBias ? located : routed),
      );
    });
    const tool = createGooglePlaces(fakeFetch(mockFetch));
    const ctx = createMockToolContext({
      sessionId: "places-located",
      env: { GOOGLE_PLACES_API_KEY: "places-test-key" },
    });
    setSessionLocation("places-located", "123 Example St, Portland, OR 97201");

    const result = await tool.execute({ query: "coffee" }, ctx);
    await tool.execute({ query: "pharmacy" }, ctx);

    // Drive time and distance ride on the place they belong to; a place with
    // no leg gets none.
    expect(result).toMatchObject([
      { name: "Tony's Pizza", driveMinutes: 10, distanceMiles: 1.6, distanceKm: 2.6 },
      { name: "Closed Slice" },
    ]);
    expect((result as Record<string, unknown>[])[1]).not.toHaveProperty("driveMinutes");

    const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    // One address lookup, asking only for the location field, then two searches.
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ textQuery: "123 Example St, Portland, OR 97201", pageSize: 1 });
    expect(new Headers(mockFetch.mock.calls[0]?.[1].headers).get("X-Goog-FieldMask")).toBe(
      "places.location",
    );
    for (const body of bodies.slice(1)) {
      expect(body.locationBias).toEqual({
        circle: { center: { latitude: 45.56, longitude: -122.55 }, radius: 15_000 },
      });
      expect(body.routingParameters).toEqual({
        origin: { latitude: 45.56, longitude: -122.55 },
        travelMode: "DRIVE",
      });
    }
    expect(new Headers(mockFetch.mock.calls[1]?.[1].headers).get("X-Goog-FieldMask")).toMatch(
      /,routingSummaries$/,
    );
  });

  test("a failed address lookup still runs the search, unbiased", async () => {
    const mockFetch = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Promise.resolve(
        body.textQuery === "nowhere at all" ? Response.json({}) : Response.json(placesBody),
      );
    });
    const ctx = createMockToolContext({
      sessionId: "places-unlocatable",
      env: { GOOGLE_PLACES_API_KEY: "places-test-key" },
    });
    setSessionLocation("places-unlocatable", "nowhere at all");
    const result = await createGooglePlaces(fakeFetch(mockFetch)).execute({ query: "coffee" }, ctx);
    expect(Array.isArray(result)).toBe(true);
    const search = mockFetch.mock.calls[1]?.[1];
    expect(JSON.parse(String(search?.body)).locationBias).toBeUndefined();
    expect(JSON.parse(String(search?.body)).routingParameters).toBeUndefined();
    expect(new Headers(search?.headers).get("X-Goog-FieldMask")).not.toContain("routingSummaries");
  });
});
