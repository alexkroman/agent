// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createToolContext } from "@alexkroman1/aai/testing";
import { fakeFetch } from "./_test-utils.ts";
import { createOpenMeteo } from "./open-meteo.ts";
import { setSessionLocation } from "./session-location.ts";

const portlandOregon = {
  name: "Portland",
  latitude: 45.52,
  longitude: -122.68,
  country: "United States",
  country_code: "US",
  admin1: "Oregon",
  timezone: "America/Los_Angeles",
};
const portlandMaine = { ...portlandOregon, admin1: "Maine", latitude: 43.66, longitude: -70.26 };
const paris = {
  name: "Paris",
  latitude: 48.85,
  longitude: 2.35,
  country: "France",
  country_code: "FR",
  admin1: "Île-de-France",
  timezone: "Europe/Paris",
};

const forecast = {
  timezone: "Europe/Paris",
  current: {
    time: "2026-09-27T14:00",
    temperature_2m: 18.2,
    apparent_temperature: 17.5,
    relative_humidity_2m: 60,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 12.4,
  },
  daily: {
    time: ["2026-09-27", "2026-09-28"],
    weather_code: [2, 63],
    temperature_2m_max: [21, 17],
    temperature_2m_min: [12, 11],
    precipitation_probability_max: [10, 80],
  },
};

/** Answer the geocoder with `places` and the forecast API with `forecast`. */
function openMeteoFetch(places: unknown[], forecastBody: unknown = forecast) {
  return vi.fn((url: string, _init: RequestInit) =>
    Promise.resolve(
      Response.json(url.includes("geocoding-api") ? { results: places } : forecastBody),
    ),
  );
}

function run(
  mockFetch: ReturnType<typeof openMeteoFetch>,
  args: Parameters<ReturnType<typeof createOpenMeteo>["execute"]>[0],
) {
  return createOpenMeteo(fakeFetch(mockFetch)).execute(args, createToolContext());
}

describe("open_meteo", () => {
  test("geocodes, then returns current conditions and a daily forecast", async () => {
    const mockFetch = openMeteoFetch([paris]);
    const result = await run(mockFetch, { location: "Paris", days: 2 });
    expect(result).toEqual({
      location: "Paris, Île-de-France, France",
      timezone: "Europe/Paris",
      units: { system: "metric", temperature: "°C", wind: "km/h", precipitation: "mm" },
      current: {
        time: "2026-09-27T14:00",
        conditions: "partly cloudy",
        temperature: 18.2,
        feelsLike: 17.5,
        humidityPercent: 60,
        windSpeed: 12.4,
        precipitation: 0,
      },
      daily: [
        {
          date: "2026-09-27",
          conditions: "partly cloudy",
          high: 21,
          low: 12,
          precipitationChancePercent: 10,
        },
        {
          date: "2026-09-28",
          conditions: "rain",
          high: 17,
          low: 11,
          precipitationChancePercent: 80,
        },
      ],
    });
    const forecastUrl = new URL(String(mockFetch.mock.calls[1]?.[0]));
    expect(forecastUrl.host).toBe("api.open-meteo.com");
    expect(forecastUrl.searchParams.get("latitude")).toBe("48.85");
    expect(forecastUrl.searchParams.get("forecast_days")).toBe("2");
    expect(forecastUrl.searchParams.get("temperature_unit")).toBe("celsius");
  });

  test("a US place defaults to imperial units", async () => {
    const mockFetch = openMeteoFetch([portlandOregon]);
    const result = await run(mockFetch, { location: "Portland" });
    expect(result).toMatchObject({ units: { system: "imperial", temperature: "°F" } });
    const forecastUrl = new URL(String(mockFetch.mock.calls[1]?.[0]));
    expect(forecastUrl.searchParams.get("temperature_unit")).toBe("fahrenheit");
    expect(forecastUrl.searchParams.get("wind_speed_unit")).toBe("mph");
    expect(forecastUrl.searchParams.get("precipitation_unit")).toBe("inch");
  });

  test("an explicit units argument overrides the country default", async () => {
    const mockFetch = openMeteoFetch([portlandOregon]);
    const result = await run(mockFetch, { location: "Portland", units: "metric" });
    expect(result).toMatchObject({ units: { system: "metric" } });
  });

  test("the qualifier picks the matching candidate, not the top hit", async () => {
    const mockFetch = openMeteoFetch([portlandMaine, portlandOregon]);
    const result = await run(mockFetch, { location: "Portland, Oregon" });
    expect(result).toMatchObject({ location: "Portland, Oregon, United States" });
    const geoUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    // The geocoder searches names only, so the qualifier never reaches it.
    expect(geoUrl.searchParams.get("name")).toBe("Portland");
    expect(geoUrl.searchParams.get("count")).toBe("10");
    expect(new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get("latitude")).toBe(
      "45.52",
    );
  });

  test("a two-letter state code matches the state's name", async () => {
    const mockFetch = openMeteoFetch([portlandOregon, portlandMaine]);
    const result = await run(mockFetch, { location: "Portland, ME" });
    expect(result).toMatchObject({ location: "Portland, Maine, United States" });
  });

  test("an unmatched qualifier answers with candidates instead of guessing", async () => {
    const mockFetch = openMeteoFetch([portlandMaine, portlandOregon]);
    const result = await run(mockFetch, { location: "Portland, Texas" });
    expect(result).toEqual({
      location: "Portland, Texas",
      error:
        'No "Portland" matched "Texas". Places with that name include: ' +
        "Portland, Maine, United States; Portland, Oregon, United States",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("no geocoding result is an error, and no forecast is requested", async () => {
    const mockFetch = openMeteoFetch([]);
    const result = await run(mockFetch, { location: "Nowhereville" });
    expect(result).toEqual({
      location: "Nowhereville",
      error: 'No place found named "Nowhereville"',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("days is clamped to 1-7", async () => {
    const mockFetch = openMeteoFetch([paris]);
    await run(mockFetch, { location: "Paris", days: 30 });
    expect(new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get("forecast_days")).toBe(
      "7",
    );
  });

  test("a forecast HTTP failure names the resolved place", async () => {
    const mockFetch = vi.fn((url: string, _init: RequestInit) =>
      Promise.resolve(
        url.includes("geocoding-api")
          ? Response.json({ results: [paris] })
          : new Response("", { status: 503, statusText: "Service Unavailable" }),
      ),
    );
    const result = await createOpenMeteo(fakeFetch(mockFetch)).execute(
      { location: "Paris" },
      createToolContext(),
    );
    expect(result).toEqual({
      error: "Forecast request failed: 503 Service Unavailable",
      location: "Paris, Île-de-France, France",
    });
  });

  test("a thrown fetch is an error result, not a thrown turn", async () => {
    const mockFetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.reject(new Error("socket hang up")),
    );
    const result = await createOpenMeteo(fakeFetch(mockFetch)).execute(
      { location: "Paris" },
      createToolContext(),
    );
    expect(result).toEqual({
      error: "Geocoding request failed: socket hang up",
      location: "Paris",
    });
  });

  test("no location argument uses the town of the session's reported address", async () => {
    const mockFetch = openMeteoFetch([portlandMaine, portlandOregon]);
    setSessionLocation("meteo-located", "123 Example St, Portland, OR 97201");
    const result = await createOpenMeteo(fakeFetch(mockFetch)).execute(
      {},
      createToolContext({ sessionId: "meteo-located" }),
    );
    expect(new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get("name")).toBe("Portland");
    expect(result).toMatchObject({ location: "Portland, Oregon, United States" });
  });

  test("no location argument and no reported location asks the model to ask", async () => {
    const mockFetch = openMeteoFetch([paris]);
    const result = await createOpenMeteo(fakeFetch(mockFetch)).execute(
      {},
      createToolContext({ sessionId: "meteo-unlocated" }),
    );
    expect(result).toEqual({ error: expect.stringContaining("ask where") });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
