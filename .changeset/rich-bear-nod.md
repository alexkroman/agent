---
"@alexkroman1/aai": patch
---

Fix three failures found while load-testing the template agents.

**`aai dev` with a `DATABASE_URL` could not start a session.** Session state
resolved to Postgres and reported `durable: true`, but nothing created
`aai_session_state` / `aai_session_events` — the tables come with whoever owns
the database, and under `aai dev` that is the developer, with no migration step
to hang the DDL off. Every session died at start with a fatal 1011 the client
reads as "Session failed to start", the real cause
(`relation "aai_session_events" does not exist`) reaching only the dev log —
while the workflow world migrated itself on the same boot and said so. `aai dev`
now applies the SDK's own `sessionStateDdl` once at boot, before the runtime
opens its pool. Best-effort: a role that may not CREATE because a real migration
already ran gets one warning, not a refused boot.

**A platform with no upload records answered every upload with a bare 500.** The
platform returns `501 platform upload records not configured`, which is a named
configuration condition, but the guest's records client let it fall to its
generic throw — so the upload routes discarded it as
`500 {"error":"Internal server error"}` and the actionable sentence stayed in the
platform's log. It is classified as `UploadsUnavailableError` now, which those
routes already answer as a 501 carrying its message. (`uploads-handler.ts` also
claimed the guest "falls back to its local store"; no such path exists, and the
comment said so for longer than it was true.)

**Guest readiness polled every 250 ms.** That interval is pure added latency on
every non-Modal cold spawn — the guest becomes ready between two attempts, so
measured boot time is the real one rounded up to a multiple of it. At 25 ms the
harness floor drops from 1021 ms to 884 ms (median 1025 → 915) in a back-to-back
A/B, and the same bundle stops timing 1310 ms or 1580 ms run to run.

Also documents, in `viteDevConfig`, that a session benchmarked through the Vite
dev port carries a multi-second tail that belongs to the proxy rather than the
agent, with the measurement and the port to use instead.
