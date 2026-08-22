---
---

Close four dependency-graph boundaries that banned a specifier which cannot
exist, and add three that were missing.

`konsistent.json`'s `core`/`cli`/`guest`/`browser-package-boundary` all listed
bare `"aai-server"` and `"aai-studio-client"`. konsistent's matcher is exact
unless the pattern ends `/*`, and neither package has a `.` export — so every
one of the 36 real `aai-server/<x>` specifiers was permitted by a rule whose own
description calls it "the reason the guest is its own package". Demonstrated by
A/B: an `aai-guest` file importing `aai-server/orchestrator` passed with "No
violations found" before, and errors now. Same trap the studio's
`tsdown.config.ts` documents one level up ("`alwaysBundle` matches the
SPECIFIER, not the package"), with no regression guard on this copy.

New: `runtime-package-boundary` (the published `aai-runtime` had none at all —
it may import `aai` and nothing else), `server-package-boundary` (aai-server
resolves `aai-guest/harness` as an ARTIFACT and must not import guest source —
the half of the documented guest boundary that nothing checked), and
`studio-browser-boundary` (the studio front-end is a browser bundle and had no
convention covering `src/**`). All three are clean today and A/B-verified to
catch an injected violation.

Also corrects AGENTS.md against the tree: 13 conventions -> 16, three published
packages -> four, 24 API reports -> 26, nine `aai` authoring subpaths -> the
thirteen it actually has, `NON_AUTHORING_SUBPATHS`' real module, the
internal-surface ratchet (paid off to 0, not 3), the cross-package name table
(the runtime split moved the four genuine collisions from `aai`/`aai-ui` to
`aai-runtime`/`aai-ui`, and left six re-exports that are not collisions), and a
"Dependency flow" paragraph that omitted `aai-runtime`, `aai-evals`, and the
repo's largest edge — `aai-studio-server` -> `aai-server`, 158 import sites
across all 36 subpath exports and not one bare specifier.

And re-keys the two coverage-baseline entries the runtime split left behind.
`packages/aai/host/workflow-wdk.ts` and `session-state-postgres.ts` moved to
`packages/aai-runtime/`, and `coverage-per-file-baseline.json` is keyed by path
— so `workflow-wdk.ts` lost its grandfathered floor, fell to the 50% global one
at 19.4%, and `pnpm check` has been red on `main` since. Re-keyed at its
measured 19.4% (verified identical across two runs); the other file now measures
83.3% and needs no entry. Deliberately NOT running `--update`, which would also
raise four unrelated entries off numbers measured on Node 22 against this
repo's `>=26`.
