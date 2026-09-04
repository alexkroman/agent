---
"aai-server": patch
---

Drop the platform DB budget's dead DevKit-world terms, delete the callerless interval sweep, and route AssemblyAI key-verification failures through the shared 503 taxonomy.

`platformDbConnectionsPerReplica` still counted a `pg.Pool` of 4 plus a dedicated `LISTEN` client for the DevKit's Postgres world — 5 per replica, 15 of the fleet budget — for something that opens no connection at all: the replay engine replaced that world with HTTP clients, and neither aai-server nor aai-runtime depends on `pg`, `graphile-worker` or `world-postgres`. `MAX_PLATFORM_DB_CONNECTIONS` is 15, so `platform-db-capacity.ts` stops subtracting 15 from the headroom it reports at boot.

Also: `_interval-sweep.ts` had no production caller (the queue scheduler needs overlapping ticks, the one policy it cannot express) and is deleted with its spec; the AssemblyAI verifier now throws `PlatformServiceUnavailableError` instead of a bespoke `HTTPException(503)`, so the platform's third HTTP dependency reaches `createErrorHandler`'s single 503 branch and logs the `service` field an operator routes on; `WorkspaceConflictError` is classified 409 at the boundary rather than only by three `instanceof` chains in aai-studio-server; the gzip middleware stops making a second full copy of an inflated deploy body; and the public-origin middleware is registered only in local dev, where it is the only place it can assign.
