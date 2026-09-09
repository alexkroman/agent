---
"@alexkroman1/aai-runtime": patch
---

`createAgentServer` now applies the session-state and workflow-journal DDL at boot when the resolved store is Postgres. It previously did neither, so the documented self-hosting path — the one the docs call "own the boot" and claim runs state and workflows "the same" — printed `runStore: "postgres"` and then died on the first run with `42P01`. Both appliers are idempotent and warn rather than throw, and the work is memoized per URL, so a server that boots today cannot start failing because of this.

A platform guest, whose stores belong to the platform, is excluded. `publicUrl` is deliberately still not sniffed from the environment — that stays the deployment layer's job, and the shipped example now does it.
