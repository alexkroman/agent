---
"@alexkroman1/aai": patch
---

Fix workflow run listings and let a workflow app run without a provider credential. `ctx.workflows.recent()` (and `GET /workflows/runs` with no key, and `aai workflow runs`) filtered the DevKit's run store by the declared workflow name where it stores the compiler's identifier, so it reported no runs for every workflow; run snapshots reported that identifier as their `workflow` instead of the declared key. An agent with `page: "static"` no longer requires a provider credential it never dials — it was demanding an AssemblyAI key, which stopped `aai dev` from starting a workflow app at all.
