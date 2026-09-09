---
"aai-server": patch
---

Point this package's comments at the runtime modules they name. `aai-runtime`'s `workflow-*` prefix became a `workflow/` directory, so eleven files here referenced paths that no longer exist — `platform/workflow-journal.ts`'s account of the hooks it mirrors, `store-conformance.ts`'s cross-references to the journal arms, and the queue modules' pointers into the replay engine. Comments only; no statement, route or exported name changed.
