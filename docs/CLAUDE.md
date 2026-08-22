# CLAUDE.md — `docs/`

The `aai-docs` workspace: the TypeDoc setup that turns the published type
surface into documentation, in two renderings.

This is not a package under `packages/`, so none of the per-package
conventions apply to it (`konsistent.json`'s `workspace-package-layout` is
scoped to `packages/{packageName}`, and the root guide's "Package guides"
table lists only those). It carries a guide anyway because Claude Code loads
the guide of the directory being worked in, and everything below is a rule you
need exactly when you are editing something in here.

## Two renderings, one set of entry points

| Command | Output | For |
| --- | --- | --- |
| `pnpm docs:api` | `docs/dist/**` (HTML) | humans, published to GitHub Pages |
| `pnpm docs:md` | `docs/api/**` (markdown, **committed**) | agents and anything reading the repo as files |

Both cover the published surface of `aai` and `aai-ui` from the built
`dist/*.d.ts`. **Two of the four publishable packages reach no reference page**,
for different reasons: the `aai-cli` subpaths are internal build hooks, and
`@alexkroman1/aai-runtime` is aimed at somebody EMBEDDING an agent rather than
writing one, so rendering it beside the SDK would rebuild the
two-thirds-of-a-combined-reference the runtime split undid. Both reasons are
written out in `UNDOCUMENTED_SUBPATHS` (`scripts/docs-markdown.mjs`), and
`aai-runtime`'s names what would change the answer: "Revisit if embedders ask
for a rendered page — then it gets its own, not a share of the SDK's."

**Documenting `aai-runtime` is a THREE-file change, and two of them are already
in the tree.** `packages/aai-runtime/typedoc.json` exists and names
`dist/runtime-barrel.d.ts`; the package has its `@module` tags. What is missing
is the pair that has to move together: `../packages/aai-runtime` in
`docs/typedoc.json`'s `entryPoints`, and the DELETION of
`UNDOCUMENTED_SUBPATHS["aai-runtime"]["."]`. Do one without the other and
`check:docs-md` fails — verified: adding only the entry point prints
`packages/aai-runtime documents . AND lists it in UNDOCUMENTED_SUBPATHS`, since
the coverage check reads the deny-list for every package `docs/typedoc.json`
names. That coupling is the deny-list working as designed: a written reason has
to be retracted in the same change that stops honouring it, so the argument
against gets read once more before it is dropped. Until both land, the package
typedoc.json is inert — the package list is derived from `docs/typedoc.json`,
so nothing reads it. Expect the render to surface `{@link}` warnings in
`aai-runtime` doc comments on its first pass; `treatWarningsAsErrors` makes
those failures, and they are the tag finding latent broken links, not causing
them.

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

## The markdown rendering is COMMITTED, and gated

`pnpm docs:md` (`scripts/docs-markdown.mjs`) writes `docs/api/`, and
`pnpm check:docs-md` fails when that tree is stale. It runs in
`scripts/check.sh` (both modes) and in the CI check job, straight after
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
printing a checkmark over nothing. `packages/aai-templates/docs-markdown-gate.test.ts`
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
downstream regenerates when it changes: the markdown rendering sets
`readme: "none"`, so `home.md` reaches `docs/dist` only.
