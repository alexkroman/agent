// Copyright 2026 the AAI authors. MIT license.
/**
 * The `open_meteo` builtin — current conditions and a daily forecast from
 * Open-Meteo (https://open-meteo.com), which needs no API key, so it is the
 * one weather source every agent can switch on without provisioning anything.
 *
 * Two requests: the geocoding API turns the place name the caller said into
 * coordinates, then the forecast API answers for those coordinates. The model
 * never sees either URL — it names a place, and this module owns both hosts.
 *
 * **A qualified place name is matched here, not by Open-Meteo.** The geocoder
 * searches the NAME field only, so `"Portland, Oregon"` finds nothing and
 * `"Portland"` finds Maine as readily as Oregon. The text before the first
 * comma is what is searched; every later part must then match the result's
 * region, county, country or country code. When none does, the tool answers
 * with the candidates it found rather than the top hit — a voice agent reading
 * out the weather for the wrong Portland is worse than one that asks.
 *
 * Units default from the matched COUNTRY (Fahrenheit/mph/inches for the US and
 * the handful of places that use them, metric everywhere else), because the
 * caller who asked about Chicago expects Fahrenheit without having said so.
 */

import { z } from "zod";
import { MAX_JSON_BYTES } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ToolDef } from "../sdk/types.ts";
import { fetchCappedJson } from "./_fetch-capped.ts";
import { builtinFetch } from "./ssrf.ts";

const openMeteoParams = z.object({
  location: z
    .string()
    .min(1)
    .describe(
      "The place to get weather for: a city, optionally qualified by region or country, " +
        "e.g. 'Paris', 'Portland, Oregon', 'Springfield, IL, US'",
    ),
  days: z
    .number()
    .int()
    .describe("How many days of daily forecast to include, 1-7 (default 3; 1 is today only)")
    .optional(),
  units: z
    .enum(["metric", "imperial"])
    .describe("Override the unit system. Omit it to use the one customary in the place's country")
    .optional(),
});

const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
/** How many geocoder candidates a qualified name is matched against. */
const GEOCODE_CANDIDATES = 10;
const MAX_FORECAST_DAYS = 7;
const DEFAULT_FORECAST_DAYS = 3;

/** Countries (ISO 3166-1 alpha-2) whose everyday weather units are imperial. */
const IMPERIAL_COUNTRIES = new Set([
  "US",
  "LR",
  "MM",
  "PR",
  "GU",
  "VI",
  "AS",
  "MP",
  "BS",
  "KY",
  "PW",
  "FM",
  "MH",
]);

/** WMO weather interpretation codes, as Open-Meteo documents them. */
const WMO_CONDITIONS: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "violent rain showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with light hail",
  99: "thunderstorm with heavy hail",
};

function conditions(code: unknown): string {
  return typeof code === "number" ? (WMO_CONDITIONS[code] ?? "unknown") : "unknown";
}

const GeocodeResultSchema = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  country: z.string().optional(),
  country_code: z.string().optional(),
  admin1: z.string().optional(),
  admin2: z.string().optional(),
  timezone: z.string().optional(),
});
type GeocodeResult = z.infer<typeof GeocodeResultSchema>;

const GeocodeResponseSchema = z.object({
  results: z.array(GeocodeResultSchema).optional(),
});

const nullableNumbers = z.array(z.number().nullable());

const ForecastResponseSchema = z.object({
  timezone: z.string().optional(),
  current: z
    .object({
      time: z.string(),
      temperature_2m: z.number().nullable(),
      apparent_temperature: z.number().nullable(),
      relative_humidity_2m: z.number().nullable(),
      precipitation: z.number().nullable(),
      weather_code: z.number().nullable(),
      wind_speed_10m: z.number().nullable(),
    })
    .optional(),
  daily: z
    .object({
      time: z.array(z.string()),
      weather_code: nullableNumbers,
      temperature_2m_max: nullableNumbers,
      temperature_2m_min: nullableNumbers,
      precipitation_probability_max: nullableNumbers,
    })
    .optional(),
});

/** "Portland, Maine, United States" — what the model reads back as the place. */
function placeName(place: GeocodeResult): string {
  return [place.name, place.admin1, place.country]
    .filter(
      (part, i, all): part is string =>
        part !== undefined && part !== "" && all.indexOf(part) === i,
    )
    .join(", ");
}

/** Does every qualifier after the first comma name this place's region or country? */
function matchesQualifiers(place: GeocodeResult, qualifiers: readonly string[]): boolean {
  const fields = [place.admin1, place.admin2, place.country, place.country_code]
    .filter((f): f is string => f !== undefined && f !== "")
    .map((f) => f.toLowerCase());
  return qualifiers.every((q) =>
    // A prefix only from three letters on, so "or" is Oregon by code, not by
    // being the first two letters of "Oruro".
    fields.some((f) => f === q || (q.length >= 3 && f.startsWith(q)) || usStateCode(f) === q),
  );
}

/** Two-letter US state codes, so "Springfield, IL" matches admin1 "Illinois". */
const US_STATES: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district of columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
};

function usStateCode(admin1: string): string | undefined {
  return US_STATES[admin1];
}

type Geocoded = { ok: true; place: GeocodeResult } | { ok: false; error: string };

async function geocode(fetchFn: typeof globalThis.fetch, location: string): Promise<Geocoded> {
  const [name = "", ...rest] = location.split(",").map((part) => part.trim());
  const qualifiers = rest.filter(Boolean).map((q) => q.toLowerCase());
  const params = new URLSearchParams({
    name,
    count: String(qualifiers.length > 0 ? GEOCODE_CANDIDATES : 1),
    language: "en",
    format: "json",
  });
  const res = await fetchCappedJson(`${GEOCODING_ENDPOINT}?${params}`, {
    fetch: fetchFn,
    accept: "application/json",
    maxBytes: MAX_JSON_BYTES,
  });
  if (!res.ok) return { ok: false, error: `Geocoding request failed: ${res.error}` };
  const parsed = GeocodeResponseSchema.safeParse(res.value);
  if (!parsed.success) return { ok: false, error: "Geocoding response had an unexpected shape" };
  const candidates = parsed.data.results ?? [];
  if (candidates.length === 0) return { ok: false, error: `No place found named "${name}"` };
  const place = candidates.find((c) => matchesQualifiers(c, qualifiers));
  if (place) return { ok: true, place };
  const seen = candidates.slice(0, 3).map(placeName).join("; ");
  return {
    ok: false,
    error: `No "${name}" matched "${rest.join(", ")}". Places with that name include: ${seen}`,
  };
}

type Units = "metric" | "imperial";
type Forecast = z.infer<typeof ForecastResponseSchema>;

/** The caller's explicit choice, else the one customary in the place's country. */
function unitsFor(place: GeocodeResult, requested: Units | undefined): Units {
  if (requested) return requested;
  return IMPERIAL_COUNTRIES.has(place.country_code?.toUpperCase() ?? "") ? "imperial" : "metric";
}

function forecastUrl(place: GeocodeResult, units: Units, days: number): string {
  const imperial = units === "imperial";
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: String(days),
    temperature_unit: imperial ? "fahrenheit" : "celsius",
    wind_speed_unit: imperial ? "mph" : "kmh",
    precipitation_unit: imperial ? "inch" : "mm",
  });
  return `${FORECAST_ENDPOINT}?${params}`;
}

/** Open-Meteo's parallel arrays, as the per-day records the model reads. */
function dailyRows(daily: NonNullable<Forecast["daily"]>) {
  return daily.time.map((date, i) => ({
    date,
    conditions: conditions(daily.weather_code[i]),
    high: daily.temperature_2m_max[i] ?? null,
    low: daily.temperature_2m_min[i] ?? null,
    precipitationChancePercent: daily.precipitation_probability_max[i] ?? null,
  }));
}

function shapeForecast(forecast: Forecast, place: GeocodeResult, units: Units) {
  const imperial = units === "imperial";
  const { current, daily } = forecast;
  return omitUndefined({
    location: placeName(place),
    timezone: forecast.timezone ?? place.timezone,
    units: {
      system: units,
      temperature: imperial ? "°F" : "°C",
      wind: imperial ? "mph" : "km/h",
      precipitation: imperial ? "in" : "mm",
    },
    current: current && {
      time: current.time,
      conditions: conditions(current.weather_code),
      temperature: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      humidityPercent: current.relative_humidity_2m,
      windSpeed: current.wind_speed_10m,
      precipitation: current.precipitation,
    },
    daily: daily && dailyRows(daily),
  });
}

export function createOpenMeteo(
  fetchFn = builtinFetch(),
): ToolDef<typeof openMeteoParams> & { guidance: string } {
  return {
    guidance:
      "Use open_meteo for current weather and forecasts. Pass the place the caller named, " +
      "with its region or country when they gave one.",
    description:
      "Get the current weather and a daily forecast for a place, from Open-Meteo. Returns " +
      "the resolved place name, current conditions (temperature, feels-like, humidity, wind, " +
      "precipitation) and per-day conditions, high, low and chance of precipitation, with the " +
      "units used. No API key required.",
    inputSchema: openMeteoParams,
    async execute(args) {
      const days = Math.max(1, Math.min(args.days ?? DEFAULT_FORECAST_DAYS, MAX_FORECAST_DAYS));
      const geo = await geocode(fetchFn, args.location);
      if (!geo.ok) return { error: geo.error, location: args.location };
      const { place } = geo;
      const units = unitsFor(place, args.units);
      const res = await fetchCappedJson(forecastUrl(place, units, days), {
        fetch: fetchFn,
        accept: "application/json",
        maxBytes: MAX_JSON_BYTES,
      });
      if (!res.ok) {
        return { error: `Forecast request failed: ${res.error}`, location: placeName(place) };
      }
      const parsed = ForecastResponseSchema.safeParse(res.value);
      if (!parsed.success) {
        return { error: "Forecast response had an unexpected shape", location: placeName(place) };
      }
      return shapeForecast(parsed.data, place, units);
    },
  };
}
