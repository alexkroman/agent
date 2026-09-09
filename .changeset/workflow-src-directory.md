---
"@alexkroman1/aai-runtime": patch
---

Give the durable-workflow half of `aai-runtime` a directory. `workflow-*` had reached 166 files — a third of the package, and more than the whole `aai` SDK — so the filename prefix is a path now: `workflow/`, with `api/`, `replay/` and `journal/` for the three clusters that were 20+ files each. Two groups moved in that never carried the prefix: the `_workflow-*` spec harnesses, and `journal-conformance*`, which is the `JournalStore` contract and imports the backends directly. No published export moved — every entry point on this package is a barrel at `src/` root — so `dist/` and the `exports` map are byte-identical.

What the move cost is the part worth recording, because the next prefix split will pay it again. Three suites discover their own subject by FILENAME, and a `startsWith("workflow-journal-")` scan matches nothing the moment that prefix becomes a directory — a registry comparing "what is in the tree" against "what is registered" then compares two empty sets and passes. All three failed loudly instead, and only because each carries an `expect(found.length).toBeGreaterThan(0)` floor under its scan. The journal scan keys on the DIRECTORY plus a `create*Journal` export now, which is strictly wider: a backend can no longer arrive under a name it fails to recognise, only in a directory it does not read.
