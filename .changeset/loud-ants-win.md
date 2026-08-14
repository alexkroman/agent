---
"@alexkroman1/aai": major
---

A tool is only ever a FILE: `agent({ tools })` is gone. `tools/incident_create.ts` that default-exports `tool({ … })` IS the tool `incident_create`, enumerated where the bundle is assembled and named by nothing. The parameter now types `tools` as a message naming the file to create, and `agent()` throws on the key as well — neither bundler type-checks user code, so the type alone would leave the rule true of this repo and of no user's project. A resolved registry attaches with `withTools`, which is what the build and `withDiscoveredTools` both call; `sessionSlot()` is what carries the state shape into a tool's own module now that a map no longer checks it.
