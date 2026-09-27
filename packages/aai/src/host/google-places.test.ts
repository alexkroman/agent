// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext, fakeFetch } from "./_test-utils.ts";
import { createGooglePlaces } from "./google-places.ts";

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
        "Google Places rejected the request (403 Forbidden) — check GOOGLE_PLACES_API_KEY is valid and has the Places API (New) enabled",
    });
  });
});
