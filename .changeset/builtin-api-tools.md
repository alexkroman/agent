---
"@alexkroman1/aai": minor
---

Three new opt-in builtins for `builtinTools`, none of them on by default:

- `open_meteo` — current weather and a daily forecast for a place, from Open-Meteo. No API key. A qualified name (`"Portland, Oregon"`, `"Springfield, IL"`) picks the matching place instead of the geocoder's top hit, and units default from the place's country.
- `brave_search` — web search through the Brave Search API, with an optional `freshness` window. Reads `BRAVE_API_KEY` from the agent env.
- `google_places` — find businesses and places (address, phone, hours, rating, price level, open now) with the Google Places API (New) text search. Reads `GOOGLE_PLACES_API_KEY` from the agent env.

The keyed two read their key per call and answer the model with an error naming the variable when it is unset; list the key in `requiredEnv` so a deploy checks it.
