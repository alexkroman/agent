---
"@alexkroman1/aai": patch
---

Fix two workflow bugs found by running a real agent against a real Postgres.

**The journal double-encoded everything in it.** Every jsonb parameter in the workflow store was bound to `$n::jsonb` while the store also passed a JSON string, and the `postgres` driver encodes a parameter according to the type Postgres infers for it — so our `JSON.stringify` and the driver's were two encodings of one value. A run started with an object input failed immediately (`blobIds is not iterable`), a step returning a string replayed as a quoted string, and a completed run's `output` reached `GET /workflows/runs/:id` double-encoded. Parameters are now bound `::text::jsonb`, which is the only spelling of the four candidates that round-trips object, string, number, boolean, array, null and undefined. No unit test could see this: the engine's suite runs on the in-memory store, which holds JS values directly.

**An oversized run input answered 500 instead of 413.** `POST /workflows/blobs` mapped the over-limit body rejection to 413; `POST /workflows/runs` did not, so a page posting too much input got `Internal server error` — indistinguishable from a broken agent. The mapping moved into the router, so every route that reads a body inherits it.
