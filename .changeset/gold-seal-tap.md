---
"@alexkroman1/aai": patch
---

Cleanup pass over the platform-workflow change: skip binary fields in the storage egress run-id walk (a 1 MiB Buffer cost 716ms of synchronous event loop, now 0.2ms), pre-swap Buffers for zero-copy views before typed-JSON encoding (1.7-2.8x on every binary-carrying call), batch the per-page ownership lookups behind one `ownsRuns`, and single-source the five platform route paths and the guest credential pair in `platform-endpoint.ts`. Removes dead code the change left behind (`APP_DB_WORLD_LISTEN`, `BundleStore.listSlugs`, `ToolSetupDeps.resolvedDb`) and corrects the studio prompt, which still taught the deleted `ctx.db` and a Database pane that no longer exists.
