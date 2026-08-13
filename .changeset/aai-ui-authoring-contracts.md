---
---

No release: repo tooling only.

`@alexkroman1/aai-ui` now carries versioned capability contracts of its own —
nine of them (`client`, `page`, `session`, `hooks`, `components`, `forms`,
`workflow`, `theme`, `client-dir`), all at epoch 1, each with a frozen `.tsx`
authoring example that `pnpm typecheck` gates. The contracts machinery is
per-package rather than hardcoded to `packages/aai`, so a capability id is
qualified (`aai-ui:workflow`), a package opts in by creating
`contracts/entrypoints/`, and its authoring subpaths are everything it publishes
with types minus a deny-list. Nothing published changes: `contracts/` is outside
the `aai-ui` tarball's `files` allowlist.
