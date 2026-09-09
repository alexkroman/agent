# CLAUDE.md — `docs/`

The `aai-docs` workspace — the narrative documentation SITE, the TypeDoc setup
that turns the published type surface into a reference in two renderings —
**and the guide for the other two committed descriptions of that same
surface**: the API reports
(`packages/*/etc/*.api.md`, `API.md`, `API-EXPORTS.json`) and the capability
epochs (`packages/*/src/contracts/`). Three artifacts, three gates, one question
each — did a signature MOVE, is the move BREAKING, and what does it MEAN — and
they are documented together because a change to any published package
usually owes all three. The root `AGENTS.md` keeps the table and the four
obligations; the arguments are here.

This is not a package under `packages/`, so none of the per-package
conventions apply to it (`konsistent.json`'s `workspace-package-layout` is
scoped to `packages/{packageName}`, and the root guide's "Package guides"
table lists only those). It carries a guide anyway because Claude Code loads
the guide of the directory being worked in, and everything below is a rule you
need exactly when you are editing something in here.

Two of the three artifacts live under `packages/`, so a reader working THERE
gets the owning package's guide instead — `packages/aai/CLAUDE.md` and
`packages/aai-ui/CLAUDE.md` each carry their own "versioned in epochs"
section, and `packages/aai-runtime/CLAUDE.md` its "The published surface is
versioned in epochs". Those say what a bump means for that package; this says
how the mechanism works.

## One Astro build renders both halves

`docs/dist` is what `.github/workflows/docs.yml` uploads to GitHub Pages, and
one build fills it:

| Command | Output | What it is |
| --- | --- | --- |
| `pnpm --filter aai-docs docs` (`astro build`) | `docs/dist/**` | the whole site — the HANDWRITTEN guide plus the generated reference at `/reference/` |
| `pnpm docs:api` | the same, from the repo root | what CI and the turbo `docs` task run |
| `pnpm docs:md` | `docs/api/**` (markdown, **committed**) | agents and anything reading the repo as files |

`pnpm --filter aai-docs docs:dev` serves it with hot reload, reference
included; nothing has to be rendered first.

**Starlight does not extract anything — TypeDoc still does.** Starlight is a
theme over a content collection with no TypeScript analysis of its own, and
nothing else in this repo carries the doc COMMENTS (the API reports strip them
by design). What `starlight-typedoc` replaces is TypeDoc's HTML THEME: it runs
the same converter with `typedoc-plugin-markdown` inside Starlight's
`config:setup` hook, writes the pages into the content collection at
`docs/src/content/docs/reference/`, and builds their sidebar group from the
reflections. So the reference is Starlight pages, `astro build` is the whole
site, and `docs:reference` and `docs/public/reference/` are gone.

**The gain that paid for the change is LINK VALIDATION.** `public/` is copied
after the content collection is built, so a `public/reference/` tree was
invisible to `starlight-links-validator` and every guide link into it was
excluded from the check — the links most likely to rot were the ones nothing
looked at. Inside the collection they are checked, and the first run found 45
broken ones across 14 pages, in three classes: anchor mismatches of the
`#dialogposition-1` shape described under "The markdown rendering is COMMITTED"
below, package overview pages the plugin's own `readme` default had deleted, and
twelve copies of `/agent/reference/` itself. All three are FIXED at the source
rather than excluded — `useHTMLAnchors`, `readme` and `entryFileName`, each
argued where it is set in `astro.config.mjs`.

**The reference render is configured in `astro.config.mjs`, and it reads
`docs/typedoc.json` by ABSOLUTE path.** TypeDoc would find it by name from the
working directory, which is right whenever `astro` runs from `docs/` and
silently renders a different surface when it is not. Two things about that
config the plugin does NOT inherit, because it passes its own defaults as
PROGRAMMATIC options and those beat a config file:

- **`readme`**, which the plugin sets to `none`. Left alone, TypeDoc's packages
  strategy emits each package overview as a bare index that the plugin then
  deletes, and the reference root links to three pages that do not exist.
  `home.md` is passed explicitly.
- **`out`**, which is why `docs/typedoc.json` no longer declares one: the
  plugin owns the site's output path and `scripts/docs-markdown.mjs` passes
  `--out` for the committed artifact.

Everything else — entry points, `treatWarningsAsErrors`, `excludeInternal`, the
`packageOptions` block — is declared once, there, and reaches both renderings.

**`/reference/` still belongs entirely to the generator.** That is why the
handwritten CLI page sits at `/cli/`: an authored page and a generated tree
sharing a URL prefix collide the first time an entry point is named like one of
the pages, and now they would collide inside ONE collection. Keep authored
pages out of `/reference/`.

**Pagefind now indexes the reference, which is why it renders one page per
MODULE.** Site search used to cover the ~15 guide pages only, because
`public/` carried no `data-pagefind-body`. As collection pages they are all
indexed, and the plugin's per-symbol default would have put ~780 symbol pages
against 15 guide pages — the guide would be a rounding error in its own search
results. `outputFileStrategy: "modules"` makes it 28, the same shape
`typedoc.markdown.json` already chose, so a reader who follows a heading link
in one artifact lands in the same place in the other.

**The generated pages are gitignored, and that is load-bearing twice.** They are
build output that happens to live under `src/`; ignoring them also keeps them
out of `assertEveryDocsPageListed` (`scripts/_docs-site-pages.mjs`), which
lists the site's pages with `git ls-files --exclude-standard` — otherwise every
generated page would demand a `MARKDOWN_FILES` entry and have its fences
compiled a second time, at the copy rather than the source.

**A package overview page opens with a duplicated `<h1>`, hidden in
`theme.css`.** The page is the package's published README, whose own
`# @alexkroman1/aai` is right where npm renders it and is also the Starlight
page title. `home.md` avoids this by carrying no heading at all (see "Code
examples in docs compile"); a README is not ours to strip, so
`.sl-markdown-content > h1:first-child` is display:none — narrow by
construction, since a Starlight page takes its title from frontmatter and no
authored page here starts its body with a heading.

**Every page of the guide is compiled.** `docs/src/content/docs/**` is listed in
`MARKDOWN_FILES` (`scripts/check-doc-examples.mjs`), so every ` ```ts ` fence on
the site is type-checked under the scaffold's tsconfig — which is the whole
population this gate exists for, since these pages are written to be the FIRST
code somebody runs. The list has to be literal (both gate specs scrape its
string literals — see `packages/aai-gates/src/_doc-example-corpus.ts`), so
`assertEveryDocsPageListed` in that script resolves the directory and fails
naming a page nobody listed. A fence that imports a file living in the READER's
project (`./agent.ts`, `../shared.ts`) cannot compile here and takes
`no-check` plus a hand-raised entry in `scripts/no-check-baseline.json`; keep
that population small, and prefer making an example self-contained. The gate
earns its keep — the first run of these pages caught `createRuntimeServer` and
`stubGenerate` being called with signatures neither has.

**The GUIDE's sidebar is the one hand-kept list left.** `docs/astro.config.mjs`
names each authored page; a new page that nobody adds to it is built and
unreachable. The reference's group is not in it — `typeDocSidebarGroup` is a
placeholder the plugin fills from the reflections, so a new subpath export
reaches the nav without an edit.

**What the plugin fills it with is PRUNED afterwards, because two dozen of the
entries led nowhere.** `starlight-typedoc` gives every module its own
collapsible group and fills it from the reflection groups — Functions, Classes,
Interfaces — each of which it expects to find as a DIRECTORY of per-symbol
pages. Under `outputFileStrategy: "modules"` (see Pagefind, above) no such
directory exists, so all 24 module groups came out with zero children: a
chevron that expands to nothing, under every package, which was most of what
the reference's nav showed. `pruneLinklessSidebarGroups()` in
`docs/astro.config.mjs` drops every group with no clickable descendant, leaving
the reference root and one Overview per package.

Nothing becomes unreachable — every module page is still built, and each
package's Overview page ends in a Modules list linking to all of them, which is
also where the module's one-line description is. Three things about it are
deliberate: it is a PLUGIN, because the items are computed inside
`starlight-typedoc`'s own `config:setup` hook and the group in the sidebar
array is still a placeholder when that array is written (Starlight runs plugins
in order and hands each the config the previous ones left, so it has to stay
AFTER `starlightTypeDoc()`); the rule is "no clickable descendants" rather than
a list of labels, so a future plugin version that fills those groups in keeps
them; and a no-op is ANNOUNCED as a warning, since that means either the
generator stopped emitting empty groups (good — the plugin can go) or the
sidebar no longer has the shape it walks (bad — the nav quietly refills with
dead ends).

Both cover the same surface from the built `dist/*.d.ts`: all of `aai` and
`aai-ui`, and **three of `aai-runtime`'s five subpaths** — `/eval`,
`/eval/vitest` and `/testing`. **The line is the READER, not the package.**
Everything rendered is what somebody writing an `agent.ts` imports, its evals
and its workflow specs included; what is left out is what somebody EMBEDDING an
agent imports (`aai-runtime`'s root barrel, ~220 exports, whose rendering beside
the SDK would rebuild the two-thirds-of-a-combined-reference the runtime split
undid), plus the two `/internal` escape hatches and `aai-cli`'s build hooks.
Every exclusion is written out in `UNDOCUMENTED_SUBPATHS`
(`scripts/docs-markdown.mjs`), and the `aai-runtime` root entry says what would
change the answer: "Revisit if embedders ask for a rendered page — then it gets
its own, not a share of the SDK's."

**A partial opt-in is what that deny-list is FOR**, and it was not obvious until
it was needed. The coverage check runs per SUBPATH — a package in
`docs/typedoc.json`'s `entryPoints` has every one of its published subpaths
either in its own `typedoc.json` or excused by name — so "document this package"
was never the unit. The three that came in are the three the `aai` README
teaches, which is what made their absence a defect rather than a preference: that
README's "Behavioral evals" section shows `describeEval` and then links "Full API
reference", which had no page for it.

**Opting a package in is a FOUR-file change and they move together.**
`../packages/aai-runtime` in `docs/typedoc.json`'s `entryPoints`, the package's
own `typedoc.json` naming the entry points, the `include` in
`docs/tsconfig.typedoc.json`, and the `dependsOn` + `inputs` of turbo's `docs`
task. Get the deny-list wrong in either direction and `check:docs-md` fails by
name: a subpath both documented and excused prints `packages/aai-runtime
documents X AND lists it in UNDOCUMENTED_SUBPATHS`, and one that is neither
prints the `entryPoints` line to add. That coupling is the deny-list working as
designed — a written reason has to be retracted in the same change that stops
honouring it.

**Expect the first render of a newly-opted-in package to be RED, and expect the
failures to be real.** `treatWarningsAsErrors` turns every unresolved reference
into one, and `aai-runtime`'s first pass produced two classes, neither caused by
the render:

- **Six types referenced by a published signature and exported by no subpath**,
  so a consumer could pass the field and not name its type — the defect class
  `pnpm check:api-nameable` now holds to a baseline (see "Quality ratchets" in
  `AGENTS.md`). Four of them (`HostGenerateFn`, `EvalWorkflowEngineOptions`,
  `JournalStore`, `DeterminismKind`) were on the eval and workflow-test surface
  the README teaches.
- **Five dead `{@link}`s**, all naming a member of an inline intersection
  (`WorkflowTestHandle.signal` and friends), which has no anchor TypeDoc can
  resolve. Latent for as long as nothing rendered these subpaths.

A link into a subpath that is deliberately NOT rendered is the third case and is
NOT a defect: `externalSymbolLinkMappings` in the package's `typedoc.json` is
where those go, pointing at whatever the deny-list says carries that surface's
orientation. Do not close one by deleting the link.

**Entry points live in each package's `typedoc.json`, and a new subpath export
needs an entry there too — `scripts/docs-markdown.mjs` fails the render if it
does not.** That rule was stated here and enforced by nothing for as long as it
existed, and four published subpaths had drifted out of the reference by the
time anything looked: `aai`'s `/slugify` and `/workspace-files`, plus
`aai-ui`'s `/client-dir`, which is contracted as its own capability and has an
API report. A missing FILE is invisible to the render floor (set well under the
actual) and invisible to the staleness diff (which compares only what the
render produced). The check reads each documented package's `exports`, and
every key with a `types` target must be an entry point or carry a written
reason in `UNDOCUMENTED_SUBPATHS` — a **deny-list**, so a new subpath defaults
into being documented and fails until somebody decides otherwise. `/internal`
is the one exclusion that predates the check.

`docs/typedoc.json` sets `excludeInternal` — tag a
symbol `@internal` to keep it exported but out of the docs — and
`treatWarningsAsErrors`, so a broken `{@link}`, or a type referenced by a
public signature but not exported, **fails the build**. Keep it at zero
warnings rather than downgrading the option. The HTML generation runs as the
turbo `docs` task, wired into `pnpm check` and the CI check job as a merge
gate; `.github/workflows/docs.yml` publishes the site
(`https://alexkroman.github.io/agent/`) on every push to `main`.

**A module is named by its `@module` tag, not by the file TypeDoc read.** Of
`aai`'s fifteen entry points thirteen carried one; the two that did not rendered
as `sdk/workflow-api-barrel` and `host/ffmpeg` — an emitted-file path, not the
specifier anybody imports. Adding the tag fixes the name in BOTH renderings,
and it is the only way to make the markdown filename match the subpath a
reader is looking for. Note the tag also promotes that block to the module
comment, which means `treatWarningsAsErrors` starts validating its `{@link}`s:
adding `@module ffmpeg` immediately failed the build on a
`{@link spawnFfmpeg}` that had never been resolvable, because the symbol is
module-internal. That is the tag finding a latent broken link, not causing
one — fix the link.

## Published type signatures are a committed report

`pnpm api-report` writes `packages/*/etc/<subpath>.api.md` — the rolled-up
public `.d.ts` for ONE REPORT PER PUBLISHED ENTRY POINT (across the four
publishable packages; `ls packages/*/etc/*.api.md` is the count, which this
paragraph has now carried stale twice, at `26` and at `29`) — plus
**`API.md` at the repo root, those same reports concatenated**, and
**`API-EXPORTS.json`, the same entry points' export NAMES**;
`pnpm check:api-report` fails when any of them is stale.

**`API-EXPORTS.json` is a second artifact over the same reports, and the split
between them is the point.** A report answers "what is the shape of this API"
and churns whenever a parameter widens or an overload is added — what a
reviewer wants, and also why a name quietly appearing or disappearing is one
line inside a hundred-line diff. **A doc COMMENT is not one of those things**:
the reports strip prose (`grep -c "^ \* " packages/aai/etc/index.api.md` is 0),
so improving a comment owes `pnpm docs:md` and nothing else — no report regen,
no epoch. This sentence used to name a doc comment as a churn source, which is
the one claim most likely to stop somebody fixing a stale one. The export list answers
only "what is IN the surface", so adding an export is a one-line addition
against an otherwise stable file. `sdk/exports.test.ts` pins some of
the same names and stays: a test fails at the moment the surface moves and names
the symbol, which is a different job from being a reviewable fact in the diff —
and it covers the entries somebody remembered to add, where this covers every
entry point. Sorting is **code-unit, never `localeCompare`**: with no explicit locale
that answers to the runtime's, so the same tree would produce a different file
under a different ICU default and the gate would report a surface change that is
really a locale change.

**`includeForgottenExports` is ON**, so a type a public signature mentions but
does not export appears as a bare `declare` with no `export` keyword. Those are
part of the surface a consumer has to satisfy — they just have no name to import
it by — and changing one can break a build while being invisible in review.
TypeDoc's `treatWarningsAsErrors` catches a subset, only for the documented
packages, and fails the run rather than showing what moved. Turning it on added
~1,300 lines; `/testing`'s report grew from 28 lines to 185, the finding being
that that entry point drags `Db`, `GenerateFn` and `WorkflowClient` in behind
it. The export lists deliberately do NOT include them: they are collected from
the `export` modifier, so a forgotten type is reviewable in the report and
absent from the list of what a consumer can import by name.

The gap it closes: **nothing else looked at a type SIGNATURE.**
`sdk/exports.test.ts` pins runtime export NAMES and says nothing about shape;
`publint` and `attw` ask packaging questions; the `.test-d.ts` files cover
`aai`'s root entry and `aai-ui`'s four hooks, and "Known limitations" in the
root `AGENTS.md` states outright that the subpath exports are not covered. So
widening a
parameter, making a field optional, or changing a return type on any OTHER
entry point was invisible in review — which matters most for the
decision it feeds, since the changeset bump type is currently a judgement made
from memory and a `patch` that was really a `major` is discovered by the
consumer whose build breaks.

**Entry points are DERIVED from `package.json#exports`, never listed.** API
Extractor's own convention is one config file per entry point, which here would
be one file per subpath whose only real content is a path — and a hand-kept
list of the public surface is precisely what goes stale in this repo (turbo
`inputs` globs that stopped matching, five vitest projects duplicated and drifted,
a `typedoc.json` list a new subpath must remember to join). A new subpath export
therefore gets a report on its first run, and `--check` fails until it is
committed, which is correct: a new subpath IS a public API change.

**`API-INDEX.md` is the third derived file, and it is the same names INVERTED.**
A report and `API-EXPORTS.json` are both indexed BY subpath, which is the wrong
direction for the question a reader actually arrives with: thirty-six subpaths
publish 1,100-odd names, so "which import gives me `WorkflowInputOf`?" was a
grep or a guess. It is generated in the same pass, gated by the same `--check`,
and split into an authoring half and a framework-internals half by a
`/internal`-and-`/host-internal` deny-list — a new subpath defaults into the
authoring half, for the reason every deny-list here exists. It carries a floor
(`MIN_INDEXED_SYMBOLS`, 600 against a measured 823) because `--check` reports a
collapsed extraction as "out of date", which invites regenerating and
committing the empty file; and
`packages/aai-gates/src/api-index-file.test.ts` is the guard under the
gate, asserting the index really is `API-EXPORTS.json` turned inside out rather
than two derivations of one broken scan agreeing with each other. Fifty-one
names list more than one subpath — that is the case worth seeing, not an error.

**`API.md` is for READERS; the per-entry-point reports are for reviewers.** One
file per entry point is the right shape for a diff — a signature change lands in
the one report that owns it — and the wrong shape for "what does this SDK
expose?", which is 29 reads plus knowing which 29. API Extractor cannot produce
the combined file: `mainEntryPointFilePath` is a single string and multi-entry
support is a long-standing unimplemented upstream request. A synthetic barrel
(`export * as stt from "./dist/…"`) does yield one DEDUPLICATED rollup, but only
per package — the repo would still have four — and every symbol trades its
`export` keyword for a `declare namespace` block, while deduplication saves ~6%
of lines. So `API.md` is a plain concatenation, generated in the same pass and
gated by the same `--check`: derived, not a second source of truth.

`packages/aai-gates/src/api-surface-file.test.ts` is the guard under that gate:
`--check` would print its checkmark for an empty file agreeing with an empty
file, which is what an assembly loop that stopped finding entry points, or a
fence parser that stopped matching, would produce. The test parses the reports
and `API.md` independently of the script and asserts the second contains the
first.

Two mechanical notes. API Extractor brings **its own TypeScript** (the JS
compiler API, which TS 7 does not expose), so no second pin is needed the way
`docs/` needs one for TypeDoc. And `reportTempFolder` is not optional: left
unset, `--check` wrote one byte-identical `<slug>.api.md` per entry point into
the package roots, caught only because markdownlint then failed on them.

`packages/aai/.npmignore` keeps `etc/` out of the tarball — the reports are for
reviewing signature changes, not for consumers. (`aai-ui`, `aai-cli` and
`aai-runtime` declare `files`, so they need no equivalent line.) Both they and
`API.md` are ignored by markdownlint, on the standing rule for generated
markdown: a prose finding in one can only be fixed by editing a file the next
run overwrites.

## The authoring surface is versioned in epochs

The reports turn a signature change into a diff, which is most of the battle —
but they answer "did anything move", and the question a reviewer has to answer is
**"is this breaking, and for whom"**. That decision is the changeset bump type,
and the section above admits how it gets made: a judgement from memory, where a
`patch` that was really a `major` is found by the consumer whose build breaks.

`pnpm check:api-contracts` (`scripts/api-contracts.mjs`, run straight after
`check:api-report` in `scripts/check.mjs` and in the CI check job) closes that.
The **capabilities** — named slices of the authoring API, each
declared by a file under `<package>/contracts/entrypoints/` re-exporting
from a published subpath — get a report of their own, and what
is committed is that report's hash plus its export list, at
`contracts/epochs/<capability>/v<N>.json`. When a capability's shape moves the
hash stops matching and the change cannot land without being CLASSIFIED:

```sh
node scripts/api-contracts.mjs --bump aai:tool --retain          # epoch N works
node scripts/api-contracts.mjs --bump aai:tool --drop "<reason>"  # and why not
```

**Three packages carry contracts — `aai`, `aai-ui` and `aai-runtime` — and a
capability is therefore QUALIFIED.** `@alexkroman1/aai-ui` is authored code in
exactly the same sense as the SDK — a `client.tsx` names `mountClient()`,
`useAgentState`, `<Form>` and `useWorkflowRun` the way an `agent.ts` names
`agent()` and `tool()`, and a signature change there breaks a user's page — so
its nine capabilities are versioned the same way (its own guide's section of
this name). Capability names are unique only WITHIN a package: `workflow` is a
capability of both and they are different contracts, so anything a human types
is `aai-ui:workflow` (a bare name still resolves when unambiguous, and ambiguity
is REFUSED rather than resolved by precedence — a classification recorded
against the wrong surface is the one failure this gate exists to prevent). Epoch
files stay unqualified; their path already names the package. **Opting a further
package in is creating `contracts/entrypoints/` inside it** — the package set is
discovered from the tree, for the reason the entry points and the capabilities
are, and its authoring subpaths are then everything it publishes with types
MINUS a deny-list of the non-authoring ones (`NON_AUTHORING_SUBPATHS` in
`scripts/_api-contracts-tree.mjs`, which exempts `aai`'s `/protocol`,
`/manifest`, `/slugify`, `/workspace-files`, `/internal` and `/host-internal`
with a reason each). Deny rather than allow for the reason the config schema
does it (see "One canonical config schema, deny-list boundaries"): a new subpath
defaults INTO the contracted surface and fails until its exports join a
capability, where an allow-list would silently leave it uncovered.

Six properties are load-bearing:

- **A retained epoch obliges a frozen, compiling artifact.**
  `contracts/compatibility/<capability>/v<N>.ts` is written the way that epoch
  was authored, under the package's own `tsconfig.json` — so **`pnpm typecheck`
  is the backward-compatibility gate**, a TEST of compatibility
  rather than a claim about it, which is what the `.test-d.ts` files cannot be:
  they pin the CURRENT shape and move with the API. On `aai` and `aai-ui` it is
  a SNIPPET an author reads; on `aai-runtime` a starter a host COPIES, because
  that is what its consumers do with it (see "The published surface is versioned
  in epochs" in `packages/aai-runtime/CLAUDE.md`). The extension is `.tsx`
  wherever the owning package's tsconfig sets `jsx` (DERIVED, not declared) — a
  component library's authoring example is JSX, and one spelled in
  `createElement` calls would compile while demonstrating an API nobody writes.
  Editing one to make a compile error go away defeats the mechanism — the error
  IS the finding. A **dropped** epoch's example is DELETED by `--bump --drop`:
  "dropped" means it no longer compiles, and a leftover file would turn a
  recorded decision into a red typecheck.

  **`contracts/compatibility/` holds one example per retained epoch**, so the
  mechanism is a test rather than a claim for the first time. The count is
  deliberately not written here: a `--bump --drop` deletes a fixture, so any
  number in this paragraph is one classification away from wrong. Four things
  are enforced on each: it exists, it is not the scaffold, it imports from
  `..`, and — the fourth — **every name its capability's retained epochs
  promised is imported by one of that capability's examples.** Per capability
  rather than per fixture, because a capability with two retained epochs splits
  its surface between them deliberately and says so in place; per-fixture
  completeness flags most of the tree, which is a rule fighting a documented
  design. All names, never a percentage: a floor cannot say which
  name went uncovered. A name the current epoch has REMOVED is forgiven by
  derivation (nothing importing it would compile); a name still on the surface
  and unexercised takes an entry in
  `scripts/api-contracts-coverage-denylist.json`, with a reason, which may
  shrink and never grow — the spec fails on an exemption that has become true.
  **It is EMPTY, and so is the tree it measures**: no capability retains a
  superseded epoch today, so no example is owed and no name can go uncovered
  (see "Every capability restarts at epoch 1" below). The gate says so by
  DERIVATION rather than assumption — its corpus check compares the
  compatibility tree on disk against what the contract tables retain, so a glob
  that stopped resolving while something WAS retained still fails, and an empty
  tree passes only because the tables agree it should be. Note what
  "never grow" is and is not: the spec
  mechanically refuses a DEAD entry, and refuses a typo'd capability id, but it
  cannot refuse an honest new one. Adding an exemption is a hand edit in a
  reviewable diff — the same contract as the two `--update` baselines — so
  keeping this file empty is a review question, not a settled one.
  `packages/aai-gates/src/api-contracts-gate.test.ts` owns all four, because
  `--bump --retain` cannot check a scaffold it has just written empty.

  **A retained epoch that promised a name the current surface has since REMOVED
  is a drop nobody made**: it cannot compile if anything names it, and it reads
  as supported only for as long as the frozen example stays quiet about it.
  There is no instance today because nothing is retained; the shape is written
  down because the first `--bump --retain` after the reset can reintroduce it.
- **The hash covers the rollup BODY, not the report file, and not all of that
  body.** API Extractor's preamble is identical in every report and is the
  tool's, not ours; hashing it would make an api-extractor upgrade that reworded
  one line bump every epoch at once, each demanding a classification for a
  change to nothing. That argument generalizes, and
  `scripts/_api-contracts-hash.mjs` is where it is applied: a hash that moves
  for a change nobody can observe does not RECORD a decision, it EXTRACTS one.
  It was measured against the 268 epoch drops recorded before the reset below,
  **114 of which (43%) carried a reason admitting, in its own words, that the
  superseded epoch "would in fact still compile"** — each one a paragraph
  somebody wrote to explain that nothing happened. That record is no longer in
  the tree, so the numbers here and in `scripts/_api-contracts-hash.mjs` are
  history rather than something to re-derive; `git log` over
  `packages/*/src/contracts/` is where it lives now. Two classes are normalized
  away, both measured off it:

  - **Parameter names, replaced positionally.** TypeScript has no named
    arguments, so a rename cannot make a caller stop compiling. One PR (`opts`
    to `options`) forced 36 classifications, every one recorded with the same
    sentence. The rename is still a real change to the reference a reader uses,
    so it stays in the committed `etc/*.api.md` and `check:api-report` still
    fails until that is regenerated — a reviewer sees it either way. What it is
    not is a compatibility decision. A type predicate naming the parameter is
    rewritten with it, or the rename escapes through `value is Foo`.
  - **The BODY of a declaration another capability of the same package
    contracts**, collapsed to `// (contracted elsewhere) <Name>`. 38% of all
    hashed declaration lines — and **74% of `aai:tool`'s** — were somebody
    else's type, reached through a field like `ToolContext.workflows`, so
    `tool` was five times likelier to be bumped by a change to another surface
    than to its own. That produced 35 drops whose reason begins "Collateral:".
    471 declarations collapse this way, 26% of the hashed text.

  Neither weakens the gate, and the tests are written in PAIRS to keep that
  honest (`packages/aai-gates/src/api-contracts-hash.test.ts`): the NAME of a
  foreign declaration is still hashed, so a capability that starts or stops
  reaching one still bumps; a declaration NO capability owns — a forgotten
  export, which `includeForgottenExports` puts there precisely because a
  consumer must satisfy it while having no name to import it by — is still
  hashed by body; and a capability's own surface is never elided. The real
  backward-compatibility test was never the hash anyway: it is the frozen
  example under `contracts/compatibility/`, which `pnpm typecheck` compiles, so
  a foreign type that breaks reddens every retained epoch that uses it whichever
  capability owns the name. Verified end to end — renaming `tool()`'s parameter
  in source and rebuilding leaves every contract green, while widening its
  return type flags `aai:tool` and only `aai:tool`.

- **Changing the normalization is a `--rehash`, never one bump per
  capability.** Every committed hash stops matching at once while not one
  signature moved, so
  `node scripts/api-contracts.mjs --rehash --because "<reason>"` recomputes each
  CURRENT epoch in place. It refuses any capability whose export list has moved
  — that is a surface change and `--bump` owns it — and it is only sound from a
  tree where the gate was GREEN beforehand, since green means every committed
  hash already matched the surface. Run it in the commit that changes the rule
  and in no other: a rehash shows in review as changed `sha256` fields under
  unchanged epoch numbers and nothing else.
- **Old epoch metadata is immutable and retained** (`v1..current`, enforced), so
  "when did this break and what did we say" is answerable from the tree.

- **Every capability restarts at epoch 1, and the history is deliberately
  gone.** The tree had accumulated 361 epoch records and 268 written drop
  reasons across 53 capabilities, and **55 of those reasons opened with the
  words "Pre-release: the SDK has no external consumers, so no superseded
  authoring style is owed a compiling example."** That is the whole answer: an
  epoch is a promise to somebody, this surface has made none yet, and a
  numbering that had reached `aai:testing@32` was recording the SDK's own
  drafting rather than anything a consumer could hold us to. So the epochs, the
  drop reasons and all 42 frozen examples were deleted and `--init` rebuilt one
  epoch per capability. Nothing is retained, so nothing is owed an example, and
  `contracts/compatibility/` is empty by construction rather than by exemption.

  What this does NOT do is weaken the gate. Every capability still has a
  committed hash and export list, a surface change still cannot land without
  `--bump`, and the first `--retain` — which is the first real promise this SDK
  makes — starts the compatibility tree over with an example that means
  something. The reset is a statement about what was owed, not about what is
  checked. Do it again only for the same reason, and only before release: once
  a consumer exists, a dropped epoch is a broken promise and deleting the record
  of it is the opposite of what this system is for.
- **The export-list delta suggests the bump.** A removed name prints `major`, an
  added one `minor`, and an unchanged list says so explicitly — this is a
  SIGNATURE change, read the report diff. That is the cheap 80% of the question,
  and it beats nothing.
- **A `--bump --drop` classifies the CURRENT epoch and nothing else.** A change
  can break OLDER supported epochs while the current one compiles, so run
  `pnpm typecheck` FIRST: the frozen examples it reddens are the epochs to drop,
  and older ones are a hand edit to `contracts.json`.
- **A capability whose promise is a VALUE or a RECIPE is not covered by the
  hash.** `aai:defaults` is the standing instance: the hash reads
  `const DEFAULT_SYSTEM_PROMPT: string` with doc comments stripped, so the
  string's content can change under a checkmark — and did. `--bump` refuses
  ("still matches epoch N"). A changeset-and-review matter, not a gated one;
  `packages/aai/CLAUDE.md` has the worked case.

**A `--bump` is the moment to ask what should come OUT.** The mechanism works in
that direction — an epoch transition can drop names wholesale — but a bump only
ever asks about the names that MOVED. What accretes is everything else:
`template-api-allowlist.json` records the exports no shipped example exercises,
and its own gate says such an export "is either missing its example or shouldn't
be public". Read that file at a bump, not only the diff — the counts are in it,
and are deliberately not restated here.

**Capabilities, not entry points, and the reason WAS the `@internal` problem.**
`@alexkroman1/aai` used to export 174 symbols from its root, **71 of them tagged
`@internal`** — `PLAYBACK_CONCEAL_FLOOR`, `MIC_SILENCE_PROBE_MS`, `WS_OPEN` — on
the same barrel as `agent()` and `tool()`, and therefore in an agent author's
autocomplete. Versioning the subpath as one unit would bump the authoring
contract every time a playback constant moved. So the capabilities name the
surface instead — `agent`, `tool`, `state`, `workflow`, `workflow-api`,
`defaults`, `utils`, `testing`, `builtins`, and one per provider stage — and the
gate asserts the naming is **exhaustive**: every `@public` export of the
authoring subpaths this leaves `aai` with belongs to exactly one capability, so
a new public export fails until somebody decides which contract it joins — the
same decision as "who is promised this". Ownership is per PACKAGE,
deliberately: three names (`isTerminal`, `WorkflowSummary`, `WorkflowOutputOf`)
are on both packages' surfaces, the same concept from the two sides of the
wire. A name published on
both `.` and a narrower subpath belongs to the narrower one.

**That set is deliberately NOT enumerated here.** This paragraph used to list
"the fourteen authoring subpaths" and was missing `/channels`, a contracted
capability with four template importers — a hand-kept list of the surface,
inside the section describing the mechanism that prevents one. It is
`authoringSubpaths()` (`scripts/_api-contracts-tree.mjs`), and
`exampleFacingSubpaths()` beside it, minus a second deny-list, is what the
template coverage ratchet reads.

**Counting them is what got them fixed, which is the argument for the whole
gate.** The internal-tagged names are the explicit exemption, committed to
`contracts/internal-surface.json` as a **ratchet that may shrink and may never
grow** (`--update-internal` lowers it, and unclaimed headroom WARNS). It opened
at 74 and stands at **0**, as do `aai-ui`'s and `aai-runtime`'s — the 71 root
ones went to `@alexkroman1/aai/internal` in the change that cut the root barrel
to the authoring API. The gate also refuses a NEW `@internal` name on a public
subpath outright, which is why `serializeToolFailure` lives in an `_`-internal
module rather than beside `toolFailure` in `sdk/utils.ts` — that file IS the
`/utils` subpath, and a tag documents a problem where a private module prevents
it.

Two mechanical notes. The epoch directory is `epochs/`, not `reports/`, because
`.gitignore` carries a bare `reports/` rule that would have swallowed it whole.
And the authoring surface is read out of the **committed** `etc/*.api.md`
reports rather than re-derived, so this and the thing a reviewer looks at cannot
disagree — which is why the ordering in `check.mjs` and CI is fixed and asserted:
a stale report would be believed.

`packages/aai-gates/src/api-contracts-gate.test.ts` is the guard under the gate,
and it has the same shape as `api-surface-file.test.ts` for the same reason: the
gate compares two things the script derives, so an extraction that stopped
finding anything would hash nothing, agree with a committed nothing, and print
"30 capability contract(s) up to date ✓". The suite reads the contract tree
independently — every package's, by the same discovery rule, so a second package
is not unguarded by the guard — and asserts every name a capability root selects
appears in that capability's current epoch, which an empty extraction cannot
satisfy. Its own parser reads the export CLAUSE rather than one name per line,
because Biome collapses a short clause onto a single line: per-line, it found
zero names in the two smallest `aai-ui` roots and would have reported the
healthiest possible contract as empty.

`contracts/` is kept out of the tarballs twice over, and the second one is not
optional: `.npmignore` excludes the source directory in `aai` (same reason as
`etc/`, plus the examples import by relative source path and would ship
unresolvable specifiers), **and each package's `tsconfig.build.json` excludes it
from the declaration emit** — `rootDir: "."` otherwise writes a `.d.ts` per
capability root and per frozen example into `dist/contracts/`, which `aai-ui`'s
`files: ["dist"]` would have shipped. `tsc --noEmit` still checks them, which is
the gate that matters. They are also out of coverage by each package's
`vitest.config.ts` (re-export lists and never-executed fixtures otherwise count
at 0% and drag the package under floors that have nothing to do with what they
measure), and its files are declared as knip `entry` points, since nothing
imports either directory and nothing is meant to. A new contract package
owes those three, plus `packages/*/src/contracts/**` staying in the `aai-templates`
turbo `inputs` — that is what stops the gate-under-the-gate being served from
cache exactly when a contract tree changes.

## "Published", "promised" and "documented" are three different sets

Three files decide them, each with a written deny-list so a new subpath
defaults IN: `package.json#exports` (published), `contracts/entrypoints/`
(promised — see "The authoring surface is versioned in epochs" above) and a
`typedoc.json` (documented). They currently disagree both ways, and each
disagreement is a decision owed out loud rather than a bug to patch quietly.

`@alexkroman1/aai/protocol` opens its reference page with "the published wire
contract … for building custom clients or servers" while
`NON_AUTHORING_SUBPATHS` deny-lists it from the contract system, so no epoch
covers its 32 names. `/manifest` is the same and reaches further — three
template `agent.test.ts` files import `toAgentConfig` from it, a subpath
`scaffold/CLAUDE.md` never mentions. Inversely `@alexkroman1/aai-runtime` is
fully contracted — its whole root barrel, twelve capabilities, frozen starters
a self-hoster copies — and reaches no reference page at all; the section above
carries that one and what would change the answer.

## The markdown rendering is COMMITTED, and gated

`pnpm docs:md` (`scripts/docs-markdown.mjs`) writes `docs/api/`, and
`pnpm check:docs-md` fails when that tree is stale. It runs in
`scripts/check.mjs` (both modes) and in the CI check job, straight after
`check:api-report` — it reads the same emitted `dist/*.d.ts`, so it belongs
after the build.

**Why a third artifact.** Two already exist and neither answers this question.
The per-entry-point reports under each package's `etc/`, and the `API.md` that
concatenates them, are rolled-up public `.d.ts`: signatures, and deliberately
nothing else, because their job is to make a signature change a reviewable
diff. Every doc comment is stripped out of them — and in this repo those
comments are the substance (`tools.md` opens with forty lines on why the
network builtins are reachable from tool code at all). The HTML site has the
comments and is a network fetch of a rendered page wrapped in navigation. So
the markdown rendering is the prose, on disk, one file per published entry
point: `cat docs/api/@alexkroman1/aai/tts.md` is the whole interaction.

**Every internal link is resolved against the heading it points at, and a dead
one fails the render.** `treatWarningsAsErrors` proves a `{@link}` resolved in
TypeDoc's MODEL; it says nothing about the anchor the markdown emitter wrote,
because the plugin allocates anchors while walking the reflection tree
(`Dialog.position` → `dialogposition`) and a reader's renderer allocates them
while walking the emitted document (`##### position()` → `position`). The two
disagreed on nine links in `index.md`: `DialogPosition` was registered as
`dialogposition-1` because the `Dialog.position` member had already taken
`dialogposition`, and no heading ever reaches that index. Two things the
checker needs to be worth having, both learned by getting them wrong:

- **It must mirror the `-1`/`-2` de-duplication renderers apply to a repeated
  heading.** Without it the pass reports 83 false positives — `sessionSlot()`
  the function and `SessionSlot` the interface legitimately share a base slug,
  and every link to the second one looks broken.
- **It REPAIRS an over-allocated suffix and fails on everything else.** A
  `#base-N` no heading produces is walked down to the first index one does; the
  repair is printed, lands in the committed diff, and can only ever point at a
  heading that exists. A missing file, or a fragment with no suffix to walk, is
  a failure — those are the shapes a real regression takes. The repair is part
  of the shared generation path, so `--check` compares against the repaired
  render and neither mode sees something the other would not.

Five decisions in `docs/typedoc.markdown.json` are load-bearing, and each is
commented in place:

- **`extends: "./typedoc.json"`.** Entry points, `excludeInternal` and
  `treatWarningsAsErrors` are declared ONCE. Without it a new subpath export
  reaches the site and silently misses this artifact — the same hand-kept-list
  staleness the API reports exist to avoid.
- **`outputFileStrategy: "modules"`.** One file per entry point. The plugin's
  default is one file per SYMBOL, which is ~700 files of a few hundred bytes:
  the wrong shape for a diff and for a reader, whose question is "what is in
  `@alexkroman1/aai/tts`".
- **`disableSources: true`.** The entry points are `dist/*.d.ts` and there are
  no declaration maps, so every "Defined in" link pointed at emitted output
  with a line number that moves on any unrelated rebuild. In a COMMITTED
  artifact that turns a one-symbol change into a hundred-line diff, which is
  how a gate becomes noise people learn to regenerate past.
- **`list`, never `table`, for every member format.** A markdown table cell
  cannot contain a blank line, so the table variants flatten every
  multi-paragraph doc comment into one run-on cell — destroying exactly the
  content this artifact exists to carry. Measured on the same tree: 752 KB of
  tables against 728 KB of lists, so it does not even cost bytes.
- **`typeDeclarationVisibility: "compact"`.** The plugin's default is
  `verbose`, which flattens a nested object type and emits a heading per LEAF —
  `###### estelle.accent`, `###### estelle.language`, sixteen voices deep, a
  third of `tts.md`, and the same again for the gateway model catalog.
  `compact` emits one heading per top-level declaration and still pushes the
  declaration's comment, so this costs no prose: measured −1,150 lines
  tree-wide, of which two were content.

**Reading order is set in `docs/typedoc.json`'s `packageOptions`, not at the
top level.** With `entryPointStrategy: "packages"` typedoc converts each
package as its own project and a top-level option never reaches it — verified
by moving both of these up a level and getting a byte-identical tree to not
setting them at all. Two live there:

- **`groupOrder`, callables first.** TypeDoc groups by reflection kind and puts
  Functions LAST, which is the worst possible order for an artifact whose whole
  premise is one `cat` per subpath: `### agent()` sat at line 5,241 of 6,044 in
  `index.md`, behind 24 constants and 33 type aliases, with `tool()` at 5,794.
  It is line 5 now. Keep the trailing `"*"` — it is where every unnamed group
  lands.
- **`excludeExternals: true`.** `lib.es5.d.ts` and `@types/node` inheritance is
  not this SDK's API, and the root page opened on 503 lines of it. −1,668
  lines, with the set of `##`/`###` headings unchanged in every file, so not
  one SDK-owned symbol was lost. Review a change to either of these by heading
  set, never line by line: the diff is the whole tree and the assertion worth
  making is that nothing but order and inherited noise moved.

**The script renders into a temp directory in BOTH modes**, and only then
decides whether to sync the result into `docs/api/` or diff against it.
Neither mode can be looking at something the other would not produce.
Write mode replaces the directory wholesale rather than copying over the top,
so a subpath that stops being exported takes its file with it instead of being
left behind to read as current.

**It carries floors (12 files, 300 KB) because a diff-based gate passes when
an empty render agrees with an empty tree** — and its whole success output is a
count, the same shape as the five gates the root guide records having caught
printing a checkmark over nothing. `packages/aai-gates/src/docs-markdown-gate.test.ts`
is the guard on the other side, over the COMMITTED tree and the config that
produced it, which the script's floor cannot see.

`docs/api/**` is ignored by markdownlint, on the standing rule for generated
markdown: a prose finding in one can only be fixed by editing a file the next
run overwrites.

## `docs/` pins its own TypeScript

TypeDoc needs the JS TypeScript compiler API — the one TS 5/6 shipped, which
the TS 7 native compiler does not — so this workspace pins `typescript@6` via
the named `typedoc` catalog entry, and `check:sherif` ignores the `aai-docs`
package to allow that one deliberate version split.

Precisely: TS 7.0 is not API-less, it is DIFFERENTLY-API'd. It ships
`typescript/unstable/{sync,async,fs,proto}` and `typescript/unstable/ast`
(scanner, parser, factory, visitor) — enough that the old "TS 7 exposes no
`createSourceFile`" line, which `aai-guest/studio-syntax.ts` also carried, was
wrong. The pin stays until TypeDoc itself migrates; nothing here can be fixed
by reaching for those subpaths.

## knip must be told about the second config

knip's typedoc plugin discovers `typedoc.json` by name and nothing else, so
`typedoc.markdown.json` was invisible and `typedoc-plugin-markdown` read as an
unused dependency. `knip.json`'s `docs` workspace names both. That entry is
load-bearing in the direction that matters — drop the plugin from the config
and knip reports the dependency, rather than the config silently rendering
without it.

For the same reason `scripts/docs-markdown.mjs` shells out to
`pnpm --filter aai-docs run docs:md` rather than `pnpm exec typedoc`:
`scripts/` belongs to the ROOT workspace, typedoc is a dependency of this one,
and reaching across would leave the dependency that makes the script runnable
declared nowhere near it.

## Code examples in docs compile

`pnpm check:doc-examples` (`scripts/check-doc-examples.mjs`, in `pnpm check`
and the CI check job) extracts every ```` ```ts ````/```` ```tsx ```` fence
from published-package doc comments, the scaffold CLAUDE.md, READMEs,
`docs/home.md`, and the studio prompt modules, and compiles each as a
self-contained module under the scaffold tsconfig. A deliberate fragment opts
out with `no-check` in the fence info string (```` ```ts no-check ````). It
reads an explicit file list, so the generated `docs/api/` is not in its corpus
— the fences there are copies of comments it already checks at the source.

`home.md` is in that list because it is the site's landing page and was the one
user-facing markdown outside it. It carried
`agent({ …, tools: { get_weather: getWeather } })` — not merely wrong but the
exact misuse `AgentParams` declares a string-literal type to reject, so the
most-read example in the project taught the thing the type system exists to
prevent, and contradicted `packages/aai/README.md` two screens away. Nothing
downstream regenerates when it changes: the committed markdown rendering sets
`readme: "none"`, so `home.md` reaches `docs/dist` only — as `/reference/`,
which is what the twelve guide links to it resolve to.

**And it opens with NO heading at all, deliberately — hence the
`markdownlint-disable-next-line MD041` on its first line.** Whatever renders
this file titles the page from the model: TypeDoc's HTML theme used the project
`name`, and Starlight now takes the `title` its plugin writes into frontmatter,
so a `# AAI SDK` in the body produces two identical `<h1>AAI SDK</h1>` elements
stacked at the top. Measured under both renderers (`docs/dist/reference/index.html`
is the current one): two `<h1>` down to one, with the `<title>` and every `##`
heading unchanged. The generated package overview pages hit the same wall from
the other side and are handled in CSS — see "One Astro build renders both
halves".

That disable comment is why `check:markdown` passes without an `ignores` entry
for the file, which is the outcome worth having: MD041 is off for one LINE and
every other rule still reads the ~90 lines of real prose below it. A
whole-file ignore was the alternative, on the precedent
`.markdownlint-cli2.jsonc` sets for the root `CLAUDE.md`.

**A comment in this file reaches the rendered page, so keep markdown
characters out of it.** TypeDoc's markdown pass does not strip an HTML comment
— it passes it through, which is invisible in HTML and is exactly why the
disable directive above is harmless. But the parser still reads the comment's
CONTENTS: a first attempt at this note lived here as a multi-line comment
quoting `# AAI SDK` in backticks, and the backticks became a `<code>` element
that broke the comment open and leaked the explanation into the page as a
second `<h1>` — reproducing the exact defect it was there to explain. Measured
both ways; the one-line, character-free directive renders as
`<!-- markdownlint-disable-next-line MD041 -->` and nothing else.

## Rendering `aai-runtime` is a docs decision, and it cannot be half-made

There is no `typedoc.json` in `packages/aai-runtime`, and its absence is now a
measured decision rather than an oversight. Two things make it one.

**A package-local config alone turns the suite red.**
`packages/aai-gates/src/docs-markdown-gate.test.ts` globs `packages/*/typedoc.json`
and asserts that every package holding one has committed markdown under
`docs/api/` — so the file cannot land before the render that produces its page.
The coupling is deliberate and it is wider than that one test: flipping this on
means `docs/typedoc.json`'s `entryPoints`, the `include` in
`docs/tsconfig.typedoc.json`, the `dependsOn` + `inputs` of turbo's `docs` task,
the retraction of `UNDOCUMENTED_SUBPATHS["aai-runtime"]["."]` in
`scripts/docs-markdown.mjs` (which errors on a subpath that is both documented
AND excused), and the regenerated `docs/api/` — one change, or a red gate.

**And the answer today is no.** `docs/CLAUDE.md` argues it: a ~220-export
surface aimed at somebody EMBEDDING an agent, rendered beside the SDK, rebuilds
the two-thirds-of-a-combined-reference the runtime split undid. The deny-list
entry says what would change the answer — "revisit if embedders ask for a
rendered page, then it gets its own, not a share of the SDK's".

What is worth not rediscovering is that the config is a five-line file plus two
options, both earned by a warning an actual render produced, and that with them
this package renders CLEAN — zero warnings under `treatWarningsAsErrors`, one
~7,100-line `@alexkroman1/aai-runtime.md`, against `aai` and `aai-ui` in the
same project:

- `entryPoints: ["dist/runtime-barrel.d.ts"]` — the only documentable subpath,
  since `./internal` is deny-listed for the reason its own module doc gives.
- `intentionallyNotExported: ["EventsNamed"]` — the `Extract` helper
  `TransportEventBody` is written as. Same call as `DistributiveOmit` in
  `packages/aai/typedoc.json`: a reader gets the resolved union in the rendered
  signature and can never name the helper.
- `externalSymbolLinkMappings` for `ai`'s `LanguageModel`, which `resolveLlm`
  returns and `LlmRegistryEntry.create` builds.

Rendered in ISOLATION it reports seven more, all `{@link Db}`-shaped links into
`@alexkroman1/aai`. Those are an artifact of the SDK not being in the project,
not a defect in these comments — do not "fix" them by deleting links.

## What writing the `aai-runtime` epoch templates found

Four things the surface cannot currently demonstrate about itself. None is a bug;
each is a decision worth making rather than inheriting.

- **`uploads` publishes a store TYPE and two blob implementations with no
  contracted way to join them** — `createUploadStore` and `resolveUploadBlobs`
  are `@internal`, so they are on `/internal` and the template has to take the
  store as a parameter. Honest for an embedder handed one by
  `createRuntimeServer`, and it means the capability cannot show its own
  end-to-end wiring.
- **`workflow` is the same shape one level up**: `WorkflowClientOptions` is
  contracted and `createWorkflowClient` is on `/internal`, so a template can
  assemble the bag and not hand it to anything. Its `logger` field is required
  and both shipped `Logger` values (`consoleLogger`, `createConsoleLogger`) are
  on `/internal` too — only the `Logger` type is contracted.

  It once reached a second epoch for a reason worth knowing, because it is the
  SIBLING version of the `TextTurnResult` hazard below: the export list did not
  move and neither did a signature, only the PROVENANCE line in the rollup —
  `WORKFLOW_API_PREFIX` reaches this package from `@alexkroman1/aai/internal`
  now rather than `/workflow-api`, since the prefix is the server's half of that
  API. A host that takes the constant from `@alexkroman1/aai-runtime` — every
  host — sees nothing. The numbering has been reset since, so the hazard is the
  durable part, not the version it landed at.
- **`WdkAdapter` is nine methods with no partial-implementation affordance**, so
  the honest template is fifty lines of skeleton and anything in the wild will either
  be that long or reach for a cast. A `createStubWdkAdapter(overrides?)` — the way
  `aai` publishes `createToolContext` — would remove the incentive to launder it.
- **`TextTurnResult` is `ReturnType<typeof streamText<ToolSet>>`**, so this
  capability's contract hash moves when the `ai` package's `StreamTextResult`
  moves. An upstream minor can force an epoch classification here with no change
  of ours.

And one real defect the templates caught, now FIXED: **`SharedServerOptions`
could not be spread into `RuntimeServerOptions`.** Its fields were optional
WITHOUT `| undefined`, so under `exactOptionalPropertyTypes` `{...hooks}` widens
each to `T | undefined` and `createRuntimeServer` rejected it (TS2379) — while
the three wrapper doors exist precisely so one hook bag can reach all of them.
The fix is on the TARGET side, which is where an A/B locates it:
`RuntimeServerOptions`' `logger`, `upgrade` and `request` accept `undefined`,
and `createAgentServer` spreads the bag. Do not narrow them back.

### A new CONTRACT package owes four things

A package that grows a `src/contracts/` directory needs the
`tsconfig.build.json` exclusion (`src/contracts`, so `rootDir: "src"` does not
emit a `.d.ts` per capability root and per frozen example into `dist/`), the
`vitest.config.ts` coverage exclusion, knip `entry` points for
`src/contracts/entrypoints/*.ts` — nothing imports a capability root and
nothing is meant to — and `packages/*/src/contracts/**` staying in the
`aai-templates` turbo `inputs`, which is what stops the gate-under-the-gate
being served from cache exactly when a contract tree changes.
