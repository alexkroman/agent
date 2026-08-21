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
`dist/*.d.ts`. The aai-cli subpaths are internal build hooks and deliberately
not documented.

**Entry points live in each package's `typedoc.json`, and a new subpath export
needs an entry there too.** `docs/typedoc.json` sets `excludeInternal` — tag a
symbol `@internal` to keep it exported but out of the docs — and
`treatWarningsAsErrors`, so a broken `{@link}`, or a type referenced by a
public signature but not exported, **fails the build**. Keep it at zero
warnings rather than downgrading the option. The HTML generation runs as the
turbo `docs` task, wired into `pnpm check` and the CI check job as a merge
gate; `.github/workflows/docs.yml` publishes the site
(`https://alexkroman.github.io/agent/`) on every push to `main`.

**A module is named by its `@module` tag, not by the file TypeDoc read.**
Fifteen entry points, and thirteen carried one; the two that did not rendered
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

Four decisions in `docs/typedoc.markdown.json` are load-bearing, and each is
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
from published-package doc comments, the scaffold CLAUDE.md, READMEs, and the
studio prompt modules, and compiles each as a self-contained module under the
scaffold tsconfig. A deliberate fragment opts out with `no-check` in the fence
info string (```` ```ts no-check ````). It reads an explicit file list, so the
generated `docs/api/` is not in its corpus — the fences there are copies of
comments it already checks at the source.
