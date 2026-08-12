---
"@alexkroman1/aai": minor
---

Publish the numeric surface as `@alexkroman1/aai/limits`, which becomes the canonical path for it. The root barrel carries 133 names and 106 of them are SCREAMING_CASE constants, so authoring autocomplete is two-thirds budgets — `agent`, `tool`, `workflow` and `sessionSlot` compete with `MAX_CLIENT_WS_BUFFERED_BYTES` for the same list. They are still re-exported from the root, deliberately: removing them breaks every consumer that reads one, so the shrink belongs in a major rather than riding along with the new subpath. Both surfaces are snapshot-pinned. Note the subpath carries 88 of the 106 — the other 18 live in `types.ts`, `workflow.ts`, `slug.ts` and `db.ts` rather than `constants.ts`, and several are not limits at all (`RESERVED_SLUGS`, `TERMINAL_WORKFLOW_STATUSES`, `WORKFLOWS_UNAVAILABLE_MESSAGE`), so where each belongs is a decision per name rather than one move.
