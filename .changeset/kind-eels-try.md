---
"@alexkroman1/aai-cli": patch
---

`aai test` no longer reports a pass over specs it did not run: an incomplete run fails with `incomplete_run` naming the files, the result carries `ran`/`unrun`/`complete` for CI to read, `--all` runs the whole suite, and `aai build`'s pre-build gate announces the same set. Scaffolded projects now wire `npm test` to their own vitest run so the CI entrypoint is the command that runs their suite.
