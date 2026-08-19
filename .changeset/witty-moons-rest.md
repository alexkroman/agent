---
"@alexkroman1/aai": minor
---

Store an upload's bytes as objects in a bucket rather than as `bytea` rows in the app's own database, and send them there straight from the browser.

Postgres charged for those bytes four ways: 6x the storage cost, every byte in the WAL and the heap and then in every base backup and the whole PITR window, the app's own queries sharing a connection pool with them (measured: p50 1.34s against 0.43s while a part was in flight), and — because bytes crossed the platform to reach the guest, whose body-drain rate is what the forward reads as liveness — an upload that was storing perfectly well being aborted as a stall.

There is one store now: the record is a row, the bytes are one object per window, and a deployed agent's parts go to a platform route the guest never holds a credential for. `UploadStore.recordPart` is the write that names a window whose bytes are already stored; its size is asked of the store, never taken from the caller. `UploadInfo.ranges` now also rides on a part's own response.

Two removals, neither of which was ever released: the file backend (`aai dev` with no `DATABASE_URL`) and the chunk table. A deployment with no database or no bucket has no uploads at all and says so by name — locally, `AAI_UPLOAD_STORAGE_URL`, `AAI_UPLOAD_STORAGE_KEY` and `AAI_UPLOAD_STORAGE_BUCKET` in the project's `.env` alongside `DATABASE_URL`.
