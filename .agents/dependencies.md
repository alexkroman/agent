<!-- Moved out of AGENTS.md so it is read ON DEMAND rather than loaded into
every task's context. AGENTS.md's "Detailed references" table points here. -->

# Dependencies and artifacts

## Dependency versions live in the pnpm catalog

Shared dependency versions are declared once, in `pnpm-workspace.yaml`'s
`catalog:` block, and packages reference them as `"zod": "catalog:"`. Thirty-two
dependencies are in it. Two things stay OUT, and both are load-bearing:

- **peerDependencies.** `react`, `react-dom`, `tailwindcss`, `vitest` and
  **`zod`** are declared as peers with wider floors (`^19.0.0`, `^4.0.0`) than
  the devDependency the repo builds against. Those are statements about what a
  CONSUMER may bring, not versions we pick; `catalog:` would narrow them to our
  own pin and break installs for anyone a minor behind. `.syncpackrc.json`
  ignores peer ranges for the same reason.

  **The test for which side a dependency belongs on is whether it appears in
  the PUBLISHED type surface, and zod is the worked case.** A `dependencies`
  entry says "I own my copy, you cannot see it"; a peer says "we must share
  one". zod is imported by eight entry-point `.d.ts` files and named by ~646
  signature references across `aai`'s reports, so a consumer's `z.object(…)`
  has to BE the type `tool()` accepts — which the first spelling cannot
  promise. Declared as a plain dependency, a version mismatch surfaced as a
  structural error deep inside zod's internals at the user's call site; as a
  peer it surfaces as an unmet peer naming the range.

  The ecosystem draws the same line, and this repo's own tree is the evidence:
  `ai` and `@hono/zod-validator` expose zod types and declare it a peer
  (`^3.25.76 || ^4.1.8`), while `knip`, `konsistent` and
  `mutation-server-protocol` keep it internal and declare it a dependency. So
  `aai` and `aai-runtime` are peers and **`aai-cli` is deliberately NOT** — it
  is an executable, like knip, and its one zod-typed subpath
  (`/project-config`) has a single workspace-internal consumer.

  Each peer stays in `devDependencies` on `catalog:` so this repo's own build
  and tests resolve it; `exports-no-dev-deps.test.ts` sanctions exactly that
  pairing and only fails a specifier that is devDependencies-ONLY.
- **`docs`'s TypeScript**, pinned to the 6.x line because TypeDoc needs the JS
  compiler API TS 7 does not ship. It uses the named `typedoc` catalog so the
  split is a declaration rather than a stray literal.

**syncpack still runs, and is what stops a package BYPASSING the catalog.**
syncpack 15 reads the catalog natively and reports a literal range on a
catalogued dependency as `DiffersToCatalog` — verified by A/B, setting
`aai-cli`'s zod to `^4.0.0` fails the lint. So the two hand-written `sameRange`
versionGroups that used to police zod and ws are gone: the catalog makes that
drift unrepresentable, and a rule comparing `catalog:` against the range it
resolves to reported a mismatch on every correct package.

`sync-scaffold-versions.mjs` carries a bump into the scaffold, which ships to
users and cannot use `catalog:` — still the one place a bump is applied twice.
It did NOT stay as it was, and the note that said so was the bug: reading a
range out of a package.json now yields `catalog:`, which it copied verbatim
into a manifest npm cannot resolve. See `check:scaffold` under "Quality
ratchets".

## A manifest has a SHAPE, and two more checks read it

Two tools that read `package.json` were installed and invoked by nothing. Both
are turbo tasks beside `check:syncpack` now, and both were RED on first run —
which is the argument for the pair.

- **`pnpm check:format`** (`syncpack format --check`) — key order, and the
  order of the conditions inside `exports`. All eleven manifests failed.

  **`sortExports` in `.syncpackrc.json` is load-bearing.** Under syncpack's
  default list `@dev/source` is unknown, so it sorts LAST and `import` lands
  ahead of it — and condition resolution takes the FIRST match, so every
  dev-source path would quietly resolve to `dist/` and the condition this
  workspace is built on would stop working, with a green formatter. The config
  names it first. Verified before adopting: every manifest is DEEP-EQUAL across
  the reformat, so it reorders and changes no value.
- **`pnpm check:dedupe`** (`pnpm dedupe --check`) — duplicate versions resolved
  side by side. Found rolldown 1.2.0 beside 1.2.4, two `@types/node`, two
  `@oxc-project/types` and sixteen duplicate `@rolldown/binding-*`; deduping
  cut 195 lockfile lines. Those are bytes in the harness bundle
  `artifact-size-report.mjs` budgets. **Full mode only** — it RESOLVES, so it
  wants a registry, and a pre-commit gate that fails on a flaky network is one
  developers learn to skip. Named in `NOT_RUN_BY_LOCAL`.

`check:sherif` passes `--fail-on-warnings` now: clean when added, which is when
a ratchet is cheapest to set.

## What a PUBLISHED manifest owes, beyond packaging

`publint` and `attw` ask whether a package RESOLVES;
`publishable-package-layout` asks which FILES it has, and konsistent's
predicates cannot read a JSON field at all. `check-publish-names.mjs` holds
what falls between — it already walks these manifests and already argues this
failure class (its header, on `repository` and the E422 only a push to main
could see).

- **`license`, plus a `LICENSE` in the package's own directory.** All four
  published packages had neither. The repo is MIT at the root, but **npm packs
  only the LICENSE in the package dir**, never an ancestor's — so four tarballs
  declared no terms, which registries and license scanners read as
  all-rights-reserved, and `npm publish` only WARNS. The field is checked by
  consensus among the four; the file, by existence.
- **`sideEffects` is a CLAIM** — the only field here whose wrong value breaks a
  consumer rather than our publish. `aai-ui` exports `./styles.css` and all
  fifteen templates `import "@alexkroman1/aai-ui/styles.css"`, an import for
  effect that `sideEffects: false` licenses a bundler to drop, unstyling every
  scaffolded app silently. So a package exporting CSS may not claim `false`; it
  names the css. `aai` and `aai-runtime` are `false` on evidence (no
  `registerProcessor`, no `customElements.define`, no top-level global
  mutation, no side-effect-only import of either anywhere); `aai-cli` is
  absent, being an executable rather than a library a consumer shakes.

All four assertions were A/B'd against a broken manifest before landing — a
check that has never failed is indistinguishable from one that cannot.

## A new version is quarantined for 24 hours

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`. This is the half of
supply-chain defence that `onlyBuiltDependencies` cannot cover: a hijacked
release does not need an install script when the package is imported by our own
code at build or test time. Nearly every npm account compromise is caught and
yanked within hours, so the window is most of the exposure, and nothing here
needs a version the day it ships.

It applies to RESOLUTION, so it only bites when the lockfile is being changed —
`pnpm install --frozen-lockfile` (CI, every check job) is unaffected. A
deliberate same-day bump adds a `minimumReleaseAgeExclude` entry WITH a reason,
rather than lowering the number.

**The root `minimumReleaseAgeExclude` holds exactly one entry, `@biomejs/*`**,
argued at the setting; an exemption for our own packages would be dead config,
since this workspace resolves `@alexkroman1/*` through `workspace:*`. Two
mechanics generalize: the pattern must be the SCOPE, because a CLI's platform
binary is an optionalDependency published in the same batch and exempting only
the wrapper fails resolution on a package nothing here declares; and an entry is
meant to be DELETED once its version clears the window.

The place that also needs one is `scaffold/pnpm-workspace.yaml` — see
`packages/aai-templates/CLAUDE.md` for the
`ERR_PNPM_NO_MATURE_MATCHING_VERSION` failure it prevents. The e2e suite is
likewise unaffected and not by luck: it already sets
`NPM_CONFIG_MINIMUM_RELEASE_AGE=0` because the tarballs it publishes to its mock
verdaccio are seconds old by construction.

## Every GitHub Action is pinned to a SHA

A tag is a mutable pointer, so `@v7` grants every future version of that code
the permissions of the job it runs in — including the release job's npm token.
Every `uses:` carries a 40-character commit SHA with the release in a trailing
comment; `guard-invariants.mjs` rule 7 fails a workflow that reuses a floating
tag. Pins are refreshed BY HAND now: Dependabot did that, and never opened a
mergeable PR here, so it was removed.

## Artifact sizes have a budget, with an escape valve

`.size-limit.json` used to sit at the repo root with two entries. It was
referenced by no script, no turbo task and no CI job, `size-limit` was not even
a devDependency, and both its limits were wrong by more than an order of
magnitude (`aai`'s `dist` is 1.7 MB against a declared 30 kB). Dead from the day
it was added — the same genre as the `ls-lint` config no pipeline ran and the
`.turbo` cache path that never matched `cacheDir`. It is deleted.

`scripts/artifact-size-report.mjs` measures what actually ships:

- **`aai-guest/dist/harness.mjs` — 17.6 MB, and nothing was watching it.** It is
  baked into the Modal guest snapshot image, so it is on the cold-start path of
  every sandbox the platform starts. Reported raw and gzip, because the image
  layer is compressed.
- **The three published tarballs**, PACKED rather than measured from `dist/`.
  `dist/` is not what ships: `files`, `.npmignore` and `prepack` all sit between
  the two, and every "we shipped the wrong thing" bug lives in that gap. File
  count is reported too, which is what catches a glob that started matching a
  directory it should not.
- **Each published package's runtime dependency list.** A new entry fails the
  budget on its own, regardless of bytes: it is transitive, it lands in every
  consumer's tree, and a byte threshold reads it as small — a 4 kB wrapper can
  pull 2 MB behind it.

`.github/workflows/artifact-size.yml` builds the PR base in a `git worktree`
(so the baseline is measured with the BASE's own lockfile), posts one sticky
comment, and enforces afterwards — a budget failure whose numbers you have to
dig out of a log is a worse version of the same information. A base that will
not build is reported and enforces nothing, out loud, rather than passing
silently.

**The `acknowledge-size-warning` label is the one place this repo lets a ratchet
move up**, and it is not an inconsistency. Every other baseline here guards
DEBT, where "only down" is right. Size is different: a feature that legitimately
adds 15% has no debt to remove, so the author's only options would be to abandon
the gate or weaken the threshold for everyone. The label demotes the failure to
a warning and **is removed on every push**, so an acknowledgement covers one
commit rather than licensing the rest of the branch.

The job is deliberately not required and not in `check.yml`: it builds the
workspace twice, so a `paths` filter keeps it off docs-only PRs — which it can
only do BECAUSE it is not required (a required check with a paths filter sits
permanently "expected" on the PRs it skips and blocks the merge).

**Create the `acknowledge-size-warning` label once** in repo settings; adding a
label that does not exist is an API error.
