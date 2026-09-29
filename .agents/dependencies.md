---
summary: >-
  The pnpm catalog, manifest shape and format checks, what a published
  manifest owes, the 24-hour release-age quarantine, action SHA pinning, and
  the artifact size budget.
read_when: >-
  adding, bumping or removing a dependency, or editing a `package.json`
---

# Dependencies and artifacts

## Dependency versions live in the pnpm catalog

Shared versions are declared once in `pnpm-workspace.yaml`'s `catalog:` and
referenced as `"zod": "catalog:"`. syncpack reports a literal range on a
catalogued dependency (`DiffersToCatalog`), so a package cannot bypass it. Two
things stay OUT:

- **peerDependencies** (`react`, `react-dom`, `tailwindcss`, `vitest`, `zod`),
  whose wider floors describe what a CONSUMER may bring; `catalog:` would narrow
  them to our pin. `.syncpackrc.json` ignores peer ranges. Each peer also sits
  in `devDependencies` on `catalog:` for the repo's own build
  (`exports-no-dev-deps.test.ts` sanctions exactly that pairing).

  **A dependency is a peer when it appears in the PUBLISHED type surface.** zod
  types are in `aai`'s and `aai-runtime`'s signatures, so a consumer's
  `z.object(…)` must be the type `tool()` accepts — they declare zod a peer.
  `aai-cli` is an executable whose one zod-typed subpath has a single internal
  consumer, so it keeps zod as a dependency.
- **`docs`'s TypeScript**, pinned to 6.x via the named `typedoc` catalog because
  TypeDoc needs the JS compiler API TS 7 lacks. The same catalog's
  `typescript-6: npm:typescript@~6.0.0` gives the root the 6.x API for
  `scripts/_api-contracts-compat.mjs`.

The scaffold ships to users and cannot use `catalog:`, so
`pnpm sync:scaffold` (`sync-scaffold-versions.mjs`) writes resolved ranges into
it; `check:scaffold` fails when stale.

## A manifest has a SHAPE, and two more checks read it

- **`pnpm check:format`** (`syncpack format --check`) — key order and the order
  of conditions inside `exports`. `sortExports` in `.syncpackrc.json` must name
  `@dev/source` first: resolution takes the first match, so sorting it last
  would silently resolve every dev import to `dist/`.
- **`pnpm check:dedupe`** (`pnpm dedupe --check`) — duplicate resolved versions,
  which cost bytes in the harness bundle. Full mode only (it needs a registry);
  listed in `NOT_RUN_BY_LOCAL`.
- `check:sherif` runs with `--fail-on-warnings`.

## What a PUBLISHED manifest owes, beyond packaging

`check-publish-names.mjs` holds what `publint`, `attw` and konsistent cannot:

- **`license` plus a `LICENSE` file in the package's own directory** — npm packs
  only the package-dir LICENSE, never an ancestor's.
- **`sideEffects` must be true to the code.** A package exporting CSS may not
  claim `false` (`aai-ui` names its css, since every template imports
  `@alexkroman1/aai-ui/styles.css` for effect); `aai` and `aai-runtime` are
  `false`; `aai-cli`, an executable, omits it.

## A new version is quarantined for 24 hours

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, because a hijacked release
is usually yanked within hours and can run at import time without an install
script. It applies only to resolution (`--frozen-lockfile` is unaffected).

- A deliberate same-day bump adds a `minimumReleaseAgeExclude` entry WITH a
  reason, never a lower number, and the entry is deleted once the version clears
  the window.
- Exclude by SCOPE (`@biomejs/*`, the one root entry), because a CLI's platform
  binary is a same-batch optionalDependency.
- `scaffold/pnpm-workspace.yaml` needs its own entries — see
  `packages/aai-templates/CLAUDE.md`. The e2e suite sets
  `NPM_CONFIG_MINIMUM_RELEASE_AGE=0` for the tarballs it publishes to its
  verdaccio.

## Every GitHub Action is pinned to a SHA

A tag is mutable and would grant future code the job's permissions (including
the npm token). Every `uses:` carries a 40-character SHA with the release in a
trailing comment; `guard-invariants` rule 7 enforces it. Pins are refreshed by
hand.

## Artifact sizes have a budget, with an escape valve

`scripts/artifact-size-report.mjs` measures what ships: `aai-guest/dist/
harness.mjs` (raw and gzip — it is on every sandbox's cold-start path), the
PACKED published tarballs with file counts, and each published package's
runtime dependency list (a new entry fails regardless of bytes).

- `.github/workflows/artifact-size.yml` builds the PR base in a `git worktree`
  with the base's own lockfile, posts one sticky comment, then enforces. A base
  that will not build is reported and enforces nothing.
- **The `acknowledge-size-warning` label demotes a budget failure to a warning
  and is removed on every push**, because size growth can be legitimate where
  debt cannot. Create the label once in repo settings.
- The job is not required and not in `check.yml`: it has a `paths` filter, and a
  required check with one blocks the PRs it skips.
