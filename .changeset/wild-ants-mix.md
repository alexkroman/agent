---
"@alexkroman1/aai-runtime": minor
---

Add the guest's Streamer client (six of seven members; readFromStream's live stream needs its own route) and per-tenant stream names on the platform. Their readFromStream looks a stream up by name alone with no run filter, so in one shared schema two agents sharing a name would share a stream — the platform qualifies the name on the way in and strips it on the way out.
