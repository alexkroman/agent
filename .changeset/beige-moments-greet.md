---
"aai-server": patch
---

Close three caching gaps on the Supabase-backed read paths.

The agent shell is served `no-store`. It referenced content-hashed assets that
only resolve through the current agents row, so a redeploy unmapped them and a
cached shell 404'd its own entry script — a white page, with no stale-build
reload on this surface to recover. It previously carried no cache headers at
all, which lets a heuristically caching intermediary reuse it.

The bundle store's row, version, and blob reads are single-flighted. The
read-through caches only ever served a read that had already finished, so a
cold replica answered a burst for one deploy with one Postgres read and one
Storage download per request: measured at 61 backend round trips for 20
browsers fetching a shell plus an asset, against 3.

Blob uploads carry a one-year cache directive, matching the immutability their
content-addressed keys already guarantee. Inert today — every read is an
authenticated download or a per-call signed URL — but Storage stamps the
directive at upload time and never revisits it.
