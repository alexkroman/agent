---
"@alexkroman1/aai-cli": patch
---

`aai --help` is grouped by what a command acts on — local development, the
studio round-trip, the deployed agent, self-hosting, account and templates —
and says that a bare `aai` in an agent directory publishes to production
(asking first at a terminal). Flags are shown kebab-case (`--skip-tests`,
`--skip-typecheck`, `--allow-preview-slug`); the camelCase spellings still
work. `aai test --all` now prints a deprecation notice (it still does
nothing: every spec runs by default). Internally every command writes through
one injected terminal seam, so the CLI's specs no longer mock modules.
