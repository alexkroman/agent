---
"aai-templates": patch
---

Make the CI Postgres readiness probe a discriminator rather than a timing gamble.

`integration-and-scenario` starts the Supabase Postgres image and waits for it before running the real-database tier. The entrypoint runs an init phase on a temporary server and then RESTARTS Postgres, so a `pg_isready` over the unix socket can be answered by a server that is about to go away — which the step already knew, and answered with three consecutive socket successes a second apart, on the theory that a settled server outlasts the init one.

That is a gamble rather than a discriminator, and it lost: run 33694602134 took all three probes inside the init phase and then hit `FATAL: the database system is shutting down` from the extension check, six seconds after `docker run`. A false red on the only required check, from the step whose reason for existing is to prevent one.

The probe is now over TCP. The entrypoint starts its temporary server with `listen_addresses=''` — socket only, precisely so nothing outside can reach a half-built database — so a probe on 127.0.0.1 cannot be answered until the real server is listening. It is also the question the suite itself asks, `AAI_TEST_PG_URL` being a TCP URL, so probe and consumer now agree by construction.

The extension check that follows is retried as well, and that is not belt-and-braces for its own sake: the probe rests on a property of the entrypoint's temporary server rather than on anything the step can observe, so the retry is what makes it correct even where that reasoning is wrong. It cannot convert a real failure — `ON_ERROR_STOP=1` plus `grep -qx ok` fails closed, so a genuinely wrong image fails all ten attempts and then the job, ~20s later rather than at once.
