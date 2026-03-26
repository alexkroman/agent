import { defineAgent, defineTool } from "@alexkroman1/aai";
import { z } from "zod";

export default defineAgent({
  name: "Weather Assistant",
  instructions:
    "You are a friendly weather assistant. When the user asks about weather, " +
    "use the get_weather tool. Keep responses short and conversational. " +
    "Report temperatures in the unit the user prefers, defaulting to Fahrenheit. " +
    "Never use visual formatting like bullet points or bold text.",
  greeting: "Hey there. Ask me about the weather anywhere in the world.",
  builtinTools: ["run_code"],
  tools: {
    get_weather: defineTool({
      description:
        "Get the current weather forecast for a city. Use this whenever the user asks about weather conditions.",
      parameters: z.object({
        city: z.string().describe("City name to look up"),
      }),
      execute: async ({ city }) => {
        // Step 1: Geocode the city
        const geoResp = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`,
        );
        if (!geoResp.ok) return { error: "Failed to geocode city" };
        const geo = (await geoResp.json()) as {
          results?: Array<{
            name: string;
            country: string;
            latitude: number;
            longitude: number;
          }>;
        };
        if (!geo.results?.length) return { error: `City not found: ${city}` };

        const { name, country, latitude, longitude } = geo.results[0]!;

        // Step 2: Fetch forecast
        const wxResp = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode,windspeed_10m&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=3`,
        );
        if (!wxResp.ok) return { error: "Failed to fetch weather" };
        const wx = (await wxResp.json()) as {
          current: {
            temperature_2m: number;
            weathercode: number;
            windspeed_10m: number;
          };
          daily: {
            temperature_2m_max: number[];
            temperature_2m_min: number[];
            weathercode: number[];
          };
        };

        return {
          location: `${name}, ${country}`,
          current: {
            temperature_c: wx.current.temperature_2m,
            temperature_f: Math.round(wx.current.temperature_2m * 9 / 5 + 32),
            weathercode: wx.current.weathercode,
            wind_kmh: wx.current.windspeed_10m,
          },
          forecast: wx.daily.temperature_2m_max.map((max, i) => ({
            high_c: max,
            low_c: wx.daily.temperature_2m_min[i],
            high_f: Math.round(max * 9 / 5 + 32),
            low_f: Math.round(wx.daily.temperature_2m_min[i]! * 9 / 5 + 32),
            weathercode: wx.daily.weathercode[i],
          })),
        };
      },
    }),
  },
});
