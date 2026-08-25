---
"@alexkroman1/aai-ui": major
---

Move four aai-ui tuning constants to @alexkroman1/aai-ui/internal, restore noImplicitAny in the scaffold, and teach the classified step call as the default. TRANSCRIBING_PLACEHOLDER, DEFAULT_PROGRESS_POLL_MS, DEFAULT_WORKFLOW_POLL_MS and MAX_MISSING_READS are no longer exported from the package root: no public signature named one and the hooks that own the intervals take them as options. Scaffolded projects now run strict with noImplicitAny ON, which restores evolving-array and evolving-let inference.
