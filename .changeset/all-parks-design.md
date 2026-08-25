---
---

Deliberately EMPTY, and the emptiness is the decision.

`@alexkroman1/aai-runtime@8.0.0` and `@alexkroman1/aai-cli@8.0.0` were never
published — the release job for `Version Packages (#1248)` died on the missing
`repository` field this change adds, after `aai` and `aai-ui` had already gone
out. So this is not an upgrade from 8.0.0; it is what 8.0.0 should have been.

A non-empty changeset would put a pending changeset on `main`, and
`changesets/action` only invokes `publish:` when there are NONE — with any
pending it takes the version path instead. It would open a Version Packages PR,
bump all four past 8.0.0, and leave two of the four permanently absent at that
version with the fixed release group split by a major. Empty keeps the publish
path live, so merging this ships the two missing 8.0.0s.
