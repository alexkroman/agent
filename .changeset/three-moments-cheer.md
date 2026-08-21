---
---

Replace two pieces of hand-rolled code with the dependency each one was
reimplementing.

`aai-evals`' fake speech stages carried a local typed listener set whose own
comment named it "`nanoevents` without the dependency" — nanoevents was already
in the tree, declared by `@alexkroman1/aai` and used by six of its provider
modules. It is now shared, so the range moved to the workspace catalog.

The three hand-rolled argv loops in `scripts/` are `node:util`'s `parseArgs`
now. None of them read the `--key=value` form, so
`artifact-size-report.mjs --output-json=<path>` measured every artifact, wrote
no file and exited 0.

No published artifact changes: `@alexkroman1/aai`'s packed manifest still
declares `nanoevents: ^10.0.0` — pnpm resolves `catalog:` at pack time.
