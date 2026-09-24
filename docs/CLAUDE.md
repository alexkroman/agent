---
summary: >-
  The `aai-docs` workspace: the narrative documentation site, both TypeDoc
  renderings, the committed markdown reference and the `typescript@6` pin —
  and the API reports and capability epochs, which answer the same question
  about the published surface.
read_when: >-
  a published signature, doc comment or subpath export changes, or
  `check:api-report`, `check:api-contracts` or `check:docs-md` fails
---

# CLAUDE.md — `docs/`

The `aai-docs` workspace (the documentation SITE and the TypeDoc reference in
two renderings) and the guide for the other two committed descriptions of the
same published surface: the API reports (`packages/*/etc/*.api.md`, `API.md`,
`API-EXPORTS.json`, `API-INDEX.md`) and the capability epochs
(`packages/*/src/contracts/`). Three artifacts, three gates: did a signature
MOVE, is the move BREAKING, and what does it MEAN.

**The procedure for a change to the published surface — regenerating, then
recording a moved hash with `--update` / `--bump` — is the
`api-contract-epoch-bump` skill** (`.claude/skills/api-contract-epoch-bump/`).
This guide holds the rules of the mechanism.

`docs/` is not under `packages/`, so per-package conventions do not apply.
`packages/aai/CLAUDE.md`, `packages/aai-ui/src/contracts/CLAUDE.md` and
`packages/aai-runtime/src/contracts/CLAUDE.md` each say what an epoch bump
means for that package.

## One Astro build renders both halves

| Command | Output | What it is |
| --- | --- | --- |
| `pnpm --filter aai-docs docs` (`astro build`) | `docs/dist/**` | the whole site — the HANDWRITTEN guide plus the generated reference at `/reference/` |
| `pnpm docs:api` | the same, from the repo root | what CI and the turbo `docs` task run |
| `pnpm docs:md` | `docs/api/**` (markdown, **committed**) | agents and anything reading the repo as files |

`pnpm --filter aai-docs docs:dev` serves it with hot reload.
`.github/workflows/docs.yml` publishes `docs/dist` to GitHub Pages on every push
to `main`; the turbo `docs` task is a merge gate in `pnpm check` and CI.

- **TypeDoc extracts; `starlight-typedoc` only replaces its HTML theme**,
  writing reference pages into the content collection at
  `docs/src/content/docs/reference/` inside Starlight's `config:setup` hook.
  That puts them under `starlight-links-validator`, so a broken internal link
  fails the build — fix it at the source, never exclude it.
- **`astro.config.mjs` reads `docs/typedoc.json` by ABSOLUTE path**, so the
  render does not depend on the working directory. The plugin's programmatic
  defaults beat the config file for two options: `readme` (passed explicitly as
  `home.md`, or package overview pages disappear) and `out` (owned by the
  plugin; `scripts/docs-markdown.mjs` passes `--out` for the committed render),
  so `docs/typedoc.json` declares no `out`. Everything else — entry points,
  `treatWarningsAsErrors`, `excludeInternal`, `packageOptions` — is declared
  once there and reaches both renderings.
- **`/reference/` belongs entirely to the generator.** Keep authored pages out
  of it (the CLI page is at `/cli/`).
- **The reference renders one page per MODULE** (`outputFileStrategy:
  "modules"`), so guide pages are not drowned in Pagefind search results and the
  site matches the committed markdown's shape.
- **The generated pages are gitignored**, which also keeps them out of
  `assertEveryDocsPageListed` (`scripts/_docs-site-pages.mjs`).
- **A package overview page's duplicate `<h1>` (from its README) is hidden in
  `theme.css`** with `.sl-markdown-content > h1:first-child`. No authored page
  may start its body with a heading.
- **Every guide page is compiled.** `docs/src/content/docs/**` is listed
  literally in `MARKDOWN_FILES` (`scripts/check-doc-examples.mjs`; the gate
  specs scrape the literals), and `assertEveryDocsPageListed` fails on a page
  nobody listed. A fence importing a reader's own file takes `no-check` plus an
  entry in `scripts/no-check-baseline.json`; prefer a self-contained example.
- **The guide's sidebar in `docs/astro.config.mjs` is hand-kept**: a new page
  nobody adds is built and unreachable. The reference group is filled by the
  plugin (`typeDocSidebarGroup`).
- **`pruneLinklessSidebarGroups()` drops every sidebar group with no clickable
  descendant** (under per-module output the plugin's per-kind groups are
  empty). It must stay a plugin AFTER `starlightTypeDoc()`, and its no-op warning
  means either the generator changed (remove it) or the sidebar shape did (fix
  it).
- **What is rendered is what somebody writing an `agent.ts` imports**: all of
  `aai` and `aai-ui`, and `aai-runtime`'s `/eval`, `/eval/vitest`,
  `/eval/simulate` and `/testing`. What an EMBEDDER imports (`aai-runtime`'s root
  barrel), the `/internal` escape hatches and `aai-cli`'s build hooks are
  excluded, each with a written reason in `UNDOCUMENTED_SUBPATHS`
  (`scripts/docs-markdown.mjs`).
- **Every subpath export with a `types` target must be an entry point in its
  package's `typedoc.json` or be excused in `UNDOCUMENTED_SUBPATHS`** — a
  deny-list, so a new subpath defaults into the reference.
  `scripts/docs-markdown.mjs` fails the render otherwise, and also fails a
  subpath both documented and excused.
- **`treatWarningsAsErrors` stays on, at zero warnings**: a broken `{@link}` or
  a type referenced by a public signature but not exported fails the build.
  `excludeInternal` keeps an `@internal` symbol exported but undocumented. A
  newly rendered package will go red on real defects (unexported referenced
  types, links into inline intersection members); fix them. A link into a
  deliberately unrendered subpath goes in the package `typedoc.json`'s
  `externalSymbolLinkMappings` — never delete the link.
- **Every entry point needs a `@module` tag**, which names the module by its
  subpath in both renderings (without it, TypeDoc uses the emitted file path).
  The tag makes the block the module comment, so its `{@link}`s are validated —
  fix any it exposes.

## Published type signatures are a committed report

`pnpm api-report` writes one `packages/*/etc/<subpath>.api.md` per published
entry point (the rolled-up public `.d.ts`), plus three derived files, all gated
by `pnpm check:api-report`:

- **`API.md`** — the reports concatenated, for readers wanting the whole surface
  in one pass (API Extractor cannot produce a multi-entry rollup).
- **`API-EXPORTS.json`** — each entry point's export NAMES, so a name appearing
  or disappearing is a one-line diff. Sorted by code unit, never
  `localeCompare` (locale would change the file).
- **`API-INDEX.md`** — the same names inverted: name → preferred import (the
  capability owner's subpath, else the narrowest), kind, `<pkg>:<capability>`
  contract and first doc-comment sentence, in audience sections cut by rule
  (`audienceOf`, `scripts/_api-index.mjs`). It names the capability, never its
  epoch, so a `--bump` does not stale it. It carries a floor
  (`MIN_INDEXED_SYMBOLS`) so an empty extraction cannot be committed.

Rules:

- **Reports strip doc comments**, so a comment-only change owes `pnpm docs:md`
  (and the index's summary column) — no report regen of signatures, no epoch.
- **`includeForgottenExports` is on**: a type a public signature reaches but no
  subpath exports appears as a bare `declare`. It is part of the surface and
  reviewable in the report; the export lists exclude it.
- **Entry points are DERIVED from `package.json#exports`**, never listed, so a
  new subpath gets a report on its first run and `--check` fails until it is
  committed.
- `reportTempFolder` must stay set, or `--check` writes stray reports into the
  package roots. API Extractor bundles its own TypeScript.
- The reports stay out of the `aai` tarball via `.npmignore` (the other three
  declare `files`) and out of markdownlint, as generated files.
- Guard specs under the gate: `packages/aai-gates/src/api-surface-file.test.ts`
  (reports and `API.md` agree, parsed independently) and `api-index-file.test.ts`
  (the index is `API-EXPORTS.json` inverted, one section per name).

## The authoring surface is versioned in epochs

`pnpm check:api-contracts` (`scripts/api-contracts.mjs`, run straight after
`check:api-report` in `check.mjs` and CI) answers "is this breaking, and for
whom". Each **capability** is a named slice of the authoring API, declared by a
file under `<package>/src/contracts/entrypoints/` re-exporting from a published
subpath. Its committed record is
`packages/<pkg>/src/contracts/epochs/<capability>/v<N>.json` (hash + export
list) beside `v<N>.rollup.txt` (pinned by sha). When a hash moves the check
fails and names the settling command — see the `api-contract-epoch-bump` skill.

### Revisions and the compatibility probe

- **A provably compatible change is a REVISION of the same epoch**
  (`--update`), not a new epoch. `scripts/_api-contracts-compat.mjs` compiles the
  epoch's ORIGINAL rollup and the new one as two modules with a probe, under
  `strict` + `exactOptionalPropertyTypes`: every old name still exported; a
  TYPE mutually assignable; a VALUE assignable new-to-old. `--bump` refuses a
  change the probe proved compatible.
- **Additive changes pass** (optional member, optional parameter, new export,
  widened parameter, narrowed return). **These need `--bump`**: a removed export,
  an added required member, a removed member (even optional — excess-property
  and missing-property errors), a changed union, an added required parameter, a
  weaker return, a stricter generic constraint.
- **Methods and constructors are compared strictly** (rewritten to function-typed
  properties), except the `label: L & Literal<L>` idiom, which TypeScript
  cannot relate strictly.
- **A one-sided `any` is UNPROVEN** — a `--bump`, not a revision.
- **`@sealed` means an author only RECEIVES the type** (a branded handle, a
  result or `ctx` object the SDK builds). A sealed type is probed new-to-old
  only, so a new required member is a revision. **Never tag** anything an author
  constructs, spreads, returns, passes in or implements (config and options
  objects, `ToolDef`, a provider, a callback parameter): there a new required
  member IS the break. The tag is trusted, and adding it shows in the
  `etc/*.api.md` diff.
- **Before compiling, the two sides are made to agree**
  (`scripts/_api-contracts-compat-rewrite.mjs`): same-named `unique symbol`
  brands are one symbol; long misuse-message literals read as one marker type;
  a declaration another capability of the package owns, or one whose closure is
  byte-identical, is taken once from the new rollup. Blind spot: a change to
  another capability's type that breaks only THIS capability's use of it is seen
  only by the owner's probe and the frozen examples.
- **Every current epoch's rollup must probe compatible with itself** (checked
  each run, `scripts/_api-contracts-staleness.mjs`), since rollups import
  sibling packages' current `dist`. The fix is a RE-PIN: edit the rollup's
  import source only, and set `rollup` in `v<N>.json` to the new text's sha256
  (file minus trailing newline); the capability `sha256` does not move.
- **The checker is TypeScript 6** (`typescript-6` at the root), because TS 7
  ships no in-process compiler API; `pnpm typecheck` still runs 7.x over every
  frozen example.
- **Probe blind spots, which are why `--retain` exists**: the
  `L & Literal<L>` methods, generic overloads (type parameters erased), an `any`
  inside a union, another package's types (same current type both sides),
  behaviour. A CHANGED generic conditional or `as`-remapped type is reported
  incompatible even when it is not (the safe direction).
  `packages/aai-gates/src/api-contracts-compat.test.ts` pairs each accepted
  change with the break beside it.

### Epoch rules

- **At most one epoch and one revision per capability per BRANCH**, measured
  against the merge-base with `origin/main` (`--base <ref|none>` overrides). A
  `--bump` whose hash equals a supported epoch points `current` back at it, so
  `current` may be older than the newest epoch.
- **Capabilities are QUALIFIED by package** — `aai`, `aai-ui` and `aai-runtime`
  carry contracts, and `workflow` exists in more than one. Anything a human types
  is `aai-ui:workflow`; a bare name works only when unambiguous, and ambiguity
  is refused. Epoch files stay unqualified (the path names the package).
- **Opting a package in is creating `src/contracts/entrypoints/` in it.** Its
  authoring subpaths are then everything it publishes with types MINUS
  `NON_AUTHORING_SUBPATHS` (`scripts/_api-contracts-tree.mjs`, a reason each) —
  a deny-list, so a new subpath defaults into the contracted surface. The sets
  are `authoringSubpaths()` / `exampleFacingSubpaths()` there; do not enumerate
  them in prose.
- **`@alexkroman1/aai/experimental` keeps unmeasured features off the
  contracted surface**: it gets an API report but no capability and no rendered
  page. Promote by MOVING names to the owning subpath, never re-exporting from
  both. A contracted signature may not name an experimental type (it would be
  unowned). `packages/aai/CLAUDE.md` has the authoring half.
- **The capability set is exhaustive**: every `@public` export of an authoring
  subpath belongs to exactly one capability of its package, so a new export fails
  until somebody decides which contract it joins. A name on both `.` and a
  narrower subpath belongs to the narrower one.
- **No `@internal` names on a public subpath.** `src/contracts/internal-surface.json`
  is a shrink-only ratchet (at 0 in all three packages; `--update-internal`
  lowers it) and the gate refuses a new one outright — put internals in an
  `_`-module or on `/internal`.
- **Every hashed declaration has exactly ONE owner**
  (`scripts/_api-contracts-ownership.mjs`). An UNOWNED declaration (exported but
  selected by no capability) or FORGOTTEN one (`ae-forgotten-export`) fails the
  check, and `--bump`/`--update` refuse a capability reaching one. The remedy is
  an owner; `src/contracts/unowned-surface.json` is a shrink-only baseline of
  what remains, deliberate entries only (misuse/diagnostic types, the
  `AgentConfig` family reached via `aai:testing`).
- **A retained epoch obliges a frozen, compiling example** at
  `packages/<pkg>/src/contracts/compatibility/<capability>/v<N>.ts` (`.tsx`
  where the package tsconfig sets `jsx`), written as that epoch was authored, so
  **`pnpm typecheck` is the backward-compatibility gate**. Never edit one to make
  an error go away — the error is the finding. `--bump --drop` deletes the
  dropped epoch's example. `api-contracts-gate.test.ts` checks each exists, is
  not the scaffold, imports from `..`, and that each capability's examples
  import every name its retained epochs promised (exemptions:
  `scripts/api-contracts-coverage-denylist.json`, shrink-only, reason each).
- **A `--bump --drop` classifies only the CURRENT epoch.** Run `pnpm typecheck`
  first; an older epoch it reddens is dropped with `--retire`. So is a retained
  epoch that promised a name the current surface has since removed — it reads
  as supported only while its example stays quiet about that name.
- **Every capability restarts at epoch 1** was a one-time pre-release reset
  (`--init`): an epoch is a promise to a consumer, and none existed yet. Do it
  again only for that reason and only before release — once a consumer exists,
  deleting a dropped epoch's record hides a broken promise.
- **Old epoch metadata is immutable**; only the current epoch's record moves,
  by revision.
- **The export-list delta suggests the bump type** (removed name `major`, added
  `minor`, unchanged `patch or minor`); a break the probe finds prints `major`.
- **A capability whose promise is a VALUE is not covered by the hash**
  (`aai:defaults`' prompt text; doc comments and literal values are
  normalized away). `--bump` refuses; it is a changeset-and-review matter.
- **A `--bump` is the moment to ask what should come OUT**: read
  `packages/aai-templates/template-api-allowlist.json` (exports no template
  exercises), not only the diff.
- **Changing the hash normalization is one `--rehash --because "<reason>"`**,
  never a bump per capability: only from a green tree, only in the commit that
  changes the rule. It refuses a capability whose export list moved.

### What the hash covers

The hash covers the re-printed rollup BODY reached from the capability's exports
(`scripts/_api-contracts-hash.mjs`), normalized so it moves only for changes a
consumer can observe:

- the API Extractor preamble, comments, release tags and import spelling are
  dropped;
- parameter names are replaced positionally (TypeScript has no named
  arguments; the rename still shows in `etc/*.api.md`);
- a declaration another capability of the package contracts is collapsed to its
  NAME, and the walk stops there;
- string literal types over 80 characters read as `string`, and a `const`'s
  literal values as their primitive.

`packages/aai-gates/src/api-contracts-hash.test.ts` pairs each normalization
with the change that must still move the hash.

### Mechanics

- The epoch directory is `epochs/`, not `reports/` (`.gitignore` ignores
  `reports/`).
- The surface is read from the COMMITTED `etc/*.api.md`, so the report must be
  fresh first — `check.mjs` and CI order the two gates and assert it.
- `packages/aai-gates/src/api-contracts-gate.test.ts` reads the contract tree
  independently and asserts every selected name appears in its capability's
  current epoch, so an empty extraction cannot pass.
- `contracts/` is kept out of the tarballs (`.npmignore` in `aai`, and each
  `tsconfig.build.json` excludes it from the declaration emit), out of coverage,
  and declared as knip `entry` points — see "A new CONTRACT package owes four
  things".

## "Published", "promised" and "documented" are three different sets

`package.json#exports` (published), `contracts/entrypoints/` (promised) and a
`typedoc.json` (documented) each have a written deny-list, so a new subpath
defaults IN; a disagreement between them is a decision to make explicitly.

- **`/protocol` is contracted (`aai:protocol`)**: the two ends of the wire ship
  on different schedules, so a renamed field breaks sessions while every build
  compiles. It is excused only from template coverage
  (`UNEXEMPLIFIED_SUBPATHS`).
- `/manifest` is still deny-listed from contracts, though three template tests
  import `toAgentConfig` from it.
- `aai-runtime`'s root barrel is fully contracted and deliberately unrendered.

## The markdown rendering is COMMITTED, and gated

`pnpm docs:md` (`scripts/docs-markdown.mjs`) writes `docs/api/`, one file per
published entry point with its doc comments, so `cat
docs/api/@alexkroman1/aai/tts.md` answers "what is in this subpath".
`pnpm check:docs-md` fails when it is stale; it runs in both `check.mjs` modes
and CI, after `check:api-report`.

- **Every internal link is resolved against an emitted heading**, mirroring
  renderers' `-1`/`-2` de-duplication. An over-allocated `#base-N` suffix is
  REPAIRED (printed, and in the committed diff); a missing file or unsuffixed
  dead fragment fails.
- **`docs/typedoc.markdown.json` has five load-bearing options**, each commented
  in place: `extends: "./typedoc.json"` (entry points declared once);
  `outputFileStrategy: "modules"`; `disableSources: true` (source links into
  `dist/` would churn the committed diff); `list`, never `table`, member formats
  (table cells cannot hold multi-paragraph comments);
  `typeDeclarationVisibility: "compact"`.
- **Reading order lives in `docs/typedoc.json`'s `packageOptions`**, because under
  `entryPointStrategy: "packages"` a top-level option never reaches a package:
  `groupOrder` puts callables first (keep the trailing `"*"`), and
  `excludeExternals: true` drops inherited lib/`@types/node` members. Review a
  change to either by heading set, not line by line.
- **The script renders into a temp directory in BOTH modes**, then syncs
  (replacing `docs/api/` wholesale, so removed subpaths disappear) or diffs.
- **Floors (12 files, 300 KB)** stop an empty render agreeing with an empty tree;
  `packages/aai-gates/src/docs-markdown-gate.test.ts` guards the committed tree
  and config, including that every package with a `typedoc.json` has committed
  markdown.
- `docs/api/**` is ignored by markdownlint (generated).

## `docs/` pins its own TypeScript

TypeDoc needs the JS compiler API, which TS 7 exposes only through
`typescript/unstable/*`, so this workspace pins `typescript@6` via the named
`typedoc` catalog and `check:sherif` ignores `aai-docs`. The pin stays until
TypeDoc migrates.

## knip must be told about the second config

knip's typedoc plugin finds only `typedoc.json`, so `knip.json`'s `docs`
workspace names `typedoc.markdown.json` too (otherwise `typedoc-plugin-markdown`
reads as unused). `scripts/docs-markdown.mjs` shells out to
`pnpm --filter aai-docs run docs:md` rather than `pnpm exec typedoc`, keeping
typedoc a dependency of this workspace.

## Code examples in docs compile

`pnpm check:doc-examples` (`scripts/check-doc-examples.mjs`, in `pnpm check` and
CI) compiles every ```` ```ts ````/```` ```tsx ```` fence in published-package doc
comments, the scaffold guide, READMEs, `docs/home.md`, the site's guide pages and
the studio prompt modules, as self-contained modules under the scaffold
tsconfig. A deliberate fragment opts out with ```` ```ts no-check ````. The list
is explicit, so the generated `docs/api/` is not in it.

**`home.md` opens with NO heading** (hence the
`markdownlint-disable-next-line MD041` on its first line), because the renderer
titles the page and a body `# …` produces a second `<h1>`. Keep markdown
characters out of any HTML comment in it: the parser reads a comment's contents
and backticks there break it open onto the page.

## Rendering `aai-runtime` is a docs decision, and it cannot be half-made

`packages/aai-runtime/typedoc.json` renders only the author-facing subpaths
(`/eval`, `/eval/vitest`, `/eval/simulate`, `/testing`). The root barrel (~220
exports for EMBEDDERS) and `/internal` stay in `UNDOCUMENTED_SUBPATHS`; the root
entry says what would change that ("revisit if embedders ask for a rendered
page — then it gets its own, not a share of the SDK's").

**Opting a package or subpath in is one change across five places**:
`docs/typedoc.json`'s `entryPoints`, the package's `typedoc.json`, the `include`
in `docs/tsconfig.typedoc.json`, the `dependsOn` + `inputs` of turbo's `docs`
task, and retracting the `UNDOCUMENTED_SUBPATHS` entry — plus the regenerated
`docs/api/`. `check:docs-md` and `docs-markdown-gate.test.ts` fail on any half.
Links into the unrendered root barrel go in `externalSymbolLinkMappings`.

## `aai-runtime` contract hazards

- **`TextTurnResult` is `ReturnType<typeof streamText<ToolSet>>`**, so an `ai`
  package minor can move its contract hash with no change of ours. A change in a
  constant's PROVENANCE line in the rollup can do the same.
- **`RuntimeServerOptions`' `logger`, `upgrade` and `request` accept
  `undefined`** so a `SharedServerOptions` bag can be spread into it under
  `exactOptionalPropertyTypes`. Do not narrow them back.
- A capability must be implementable from what it exports: when a template
  cannot use half of a surface, move that half to `/internal` rather than
  contracting more.

### A new CONTRACT package owes four things

A package that grows a `src/contracts/` directory needs the
`tsconfig.build.json` exclusion (`src/contracts`, so `rootDir: "src"` does not
emit a `.d.ts` per capability root and per frozen example into `dist/`), the
`vitest.config.ts` coverage exclusion, knip `entry` points for
`src/contracts/entrypoints/*.ts` — nothing imports a capability root and
nothing is meant to — and `packages/*/src/contracts/**` staying in the
`aai-templates` turbo `inputs`, which is what stops the gate-under-the-gate
being served from cache exactly when a contract tree changes.
