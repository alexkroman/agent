# aai-docs

## 0.1.0

### Minor Changes

- dd5a65f: Add an Evals page to the guide, after Testing.
  
  The site taught `aai test` and stopped there, so the second command a scaffolded project ships — `aai eval`, and the whole published harness behind it — was documented only in the SDK reference and in template comments. A reader following the guide had no page telling them the difference between asserting what their code does and measuring what the agent did.
  
  `/build/evals/` covers `describeEval`, what a turn hands back, the event readers on `@alexkroman1/aai-runtime/eval`, multi-turn cases with `sayAll`/`turnCalling`, and `describeWorkflowEval` — plus the three things a green run is easiest to misread over: which model a run got (live vs scripted, and the `live`/`scripted` markers that decide which cases are honest in which mode), that no eval sees anything below the audio boundary, and that one run of a probabilistic system is not a verdict.
  
  Every fence compiles. The examples import `virtual:aai/agent` — declared by `scaffold/global.d.ts`, and the right import for an eval besides, since that is the agent with `tools/` discovered — so the page adds no `no-check` debt. Testing links to it in both directions.
- 6af6624: Add a narrative documentation site, and simplify the README onto it.
  
  `docs/` rendered TypeDoc and nothing else, so the only documentation a user could reach was an alphabetical list of ~800 symbols — no help at all to somebody who has not yet written an `agent.ts`, which left the README to be the guide by default at 436 lines.
  
  An Astro + Starlight site now lives under `docs/src/`: fifteen short pages across Get started, Build, Ship it, Going further and Reference. The generated reference is untouched underneath it — `docs:reference` renders TypeDoc into `docs/public/reference/`, `astro build` copies `public/` through verbatim, and `docs/dist` is still what `docs.yml` uploads. `/reference/` belongs entirely to the generated tree, which is why the handwritten CLI page sits at `/cli/`.
  
  Three things gate it, and two of them found real defects on their first run:
  
  - **The build runs on every PR.** CI already ran `turbo run docs`; that task now builds both halves, so a page that fails to build fails the required check rather than the Pages deploy after merge.
  - **Every ` ```ts ` fence compiles**, under the same gate as the JSDoc examples (`scripts/check-doc-examples.mjs`). It rejected `createRuntimeServer(runtime)` and `stubGenerate([…])` — neither is a signature that exists. Because both gate specs scrape `MARKDOWN_FILES`' string literals, `assertEveryDocsPageListed` resolves the directory and fails naming a page nobody listed.
  - **Broken internal links fail the build** (`starlight-links-validator`). This caught a defect on all fifteen pages: Astro prefixes `base` onto sidebar entries it owns and onto nothing else, so every in-page markdown link and the hero action resolved above the Pages project root.
  
  Pagefind indexes only what Starlight marks, so site search covers the guide and not the ~780 reference files.
- 7f9bdbe: Render the API reference inside Starlight rather than TypeDoc's own HTML theme.
  
  `docs/` was two builds filling one `dist/`: `astro build` for the handwritten guide, and a separate `typedoc` run rendering HTML into `docs/public/reference/`, which Astro copied through verbatim. `starlight-typedoc` collapses that to one build. TypeDoc is still the extractor — Starlight has no TypeScript analysis of its own, and nothing else in the repo carries the doc COMMENTS, since the API reports strip them by design — but its HTML theme is gone and the reference is Starlight pages in the content collection. `docs:reference` and `docs/public/reference/` are gone with it; `docs/dist` is still what `docs.yml` uploads.
  
  **The gain that paid for it is link validation.** Astro copies `public/` after the content collection is built, so that tree was invisible to `starlight-links-validator` and every guide link into `/reference/` was excluded from the check — the links most likely to rot were the ones nothing looked at. Inside the collection they are checked, and the first run found 45 broken links across 14 pages, in three classes, each fixed where it was caused rather than excluded:
  
  - **`useHTMLAnchors`.** `treatWarningsAsErrors` proves a `{@link}` resolved in TypeDoc's MODEL; the anchor it then writes is allocated while walking the reflection tree, so `DialogPosition` becomes `#dialogposition-1` once the `Dialog.position` member has taken `#dialogposition` — an index no heading a markdown renderer emits ever reaches. The headings now carry the id the generator used. `scripts/docs-markdown-links.mjs` repairs the same class in the committed artifact by walking the suffix down, and keeps doing so: inline HTML is noise in a file read as text.
  - **`readme`, passed explicitly.** The plugin sets `readme: "none"` as a PROGRAMMATIC option, which beats a config file, so `typedoc.json`'s value was not enough. Left alone, the packages strategy emits each package overview as a bare index the plugin then deletes, and the reference root links to three pages that do not exist.
  - **`entryFileName: "index"`.** The landing page is `/reference/` — the URL twelve guide pages already link to. It costs one collision: `@alexkroman1/aai`'s root module is NAMED `index` (no `@module` tag on the barrel, so TypeDoc falls back to the file) and already wanted `index.md` in the package directory, so the package overview keeps that name and the module page becomes `index-1.md`. Every link to it is generated, so the wart is the URL alone.
  
  **One page per MODULE, not per symbol.** Pagefind indexes every page in the collection, and the plugin's per-symbol default is ~780 of them — against fifteen guide pages, the guide would be a rounding error in its own search results. `outputFileStrategy: "modules"` gives 28, the shape `typedoc.markdown.json` already chose, so a heading link resolves to the same place in both artifacts.
  
  Entry points, `treatWarningsAsErrors`, `excludeInternal` and `packageOptions` stay declared once in `docs/typedoc.json`, read by ABSOLUTE path so a run from another working directory cannot silently render a different surface. `out` comes out of that file: the plugin owns the site's output path, and `scripts/docs-markdown.mjs` passes `--out` for the committed tree. Nothing else about the published-surface artifacts moves — `docs/api/**` is unchanged at 27 files, and the API reports, `API.md`, the export lists and the capability epochs are untouched.
  
  Two consequences worth knowing. The generated pages are gitignored, which is build output that happens to live under `src/` — and also what keeps them out of `assertEveryDocsPageListed` (it lists the site's pages with `git ls-files --exclude-standard`) and out of markdownlint. And a package overview page opens with its published README's own `# @alexkroman1/aai`, which is right where npm renders it and is also the Starlight page title, so `.sl-markdown-content > h1:first-child` is hidden in `theme.css` — narrow by construction, since a Starlight page takes its title from frontmatter and no authored page here starts its body with a heading.

### Patch Changes

- 942d0e5: Cut compiler scaffolding out of two documentation examples.
  
  `more/background-jobs.md`'s first fence was the largest in the docs at 33
  lines, and 9 of them were two stub function bodies returning fake segments so
  the fence would compile. The prose above it promises "a workflow body is an
  ordinary exported async function of its input and a `WorkflowContext`", and a
  reader had to work out for themselves that the bottom third of the example was
  not part of that. They are `declare function` lines now — the technique the
  sibling fence twenty lines further down already uses — which drops the fence to
  26 lines and reads as "assume these exist" rather than as code to study. The
  one real teaching point that had been buried inside a stub body, that a step is
  where the whole Node runtime is available and the body is not, moves up to the
  `ctx.step` call site where it is visible.
  
  `build/agent.md`'s slot declaration used `() => ({ items: [] as string[] })` —
  the cast `build/state.md` explicitly names as the thing not to do, in a comment
  reading "The return annotation is what types the value — no `[] as Item[]`
  cast". It is the annotation form now, at the same line count. One page naming
  an anti-pattern while a sibling page ships it is the same drift as the
  `sky`/`conditions` split between `build/tools.md` and the scaffold's own
  `get_weather`.
  
  Neither example opts out of the gate to get shorter: `pnpm check:doc-examples`
  still compiles 363 fences, and the `no-check` budget is untouched at 115.
- a4911ce: Drop the SDK reference sidebar entries that led nowhere.
  
  `starlight-typedoc` gives every module its own collapsible sidebar group and
  fills it from the reflection groups — Functions, Classes, Interfaces — each of
  which it expects to find as a directory of per-symbol pages. The site renders
  one page per MODULE instead (`outputFileStrategy: "modules"`, so Pagefind
  indexes 28 pages rather than ~780), so no such directory exists and all 24
  module groups came out with zero children: under every package, a chevron that
  expanded to nothing. That was most of what the reference's nav showed.
  
  `pruneLinklessSidebarGroups()` in `docs/astro.config.mjs` removes every group
  with no clickable descendant, leaving the reference root and one Overview per
  package. Nothing becomes unreachable: each module page is still built, and each
  package's Overview page ends in a Modules list linking to all of them — which
  is also where the module's one-line description is, so it is the better place
  to choose from.
  
  It is a plugin rather than an edit to the sidebar array because the items are
  computed inside `starlight-typedoc`'s own `config:setup` hook, and the group in
  that array is still a placeholder when it is written; Starlight runs plugins in
  order and hands each the config the previous ones left, so it sits after
  `starlightTypeDoc()`. The rule is "no clickable descendants" rather than a list
  of labels, so a future plugin version that fills those groups in keeps them,
  and a no-op is announced as a build warning — that means either the generator
  stopped emitting empty groups or the sidebar no longer has the shape being
  walked, and the second one refills the nav with dead ends silently.
- f75ad5f: Fix every live template eval failure, and the instrument that hid them.
  
  `pnpm test:eval:templates` failed 15 of 110 cases; it now fails none. The
  instrument came first, because it is why finding them took eight passes:
  `AAI_EVAL_REPEAT` and `AAI_EVAL_ONLY` were declared in `check:eval`'s `env`,
  forwarded by `run-evals.mjs` and documented in its header, but read only by
  `aai-evals` — for all 28 template suites both were silent no-ops. `eval/_env.ts`
  reads them now and `SuiteSpread` reports the spread, so a case that failed only
  SOME repeats prints as `UNSTABLE (n/m)` with the failure it saw and does not
  fail, while one that failed every repeat does. Opt-in: an unset environment is
  byte-identical to before. `describeWorkflowEval` is wired in too, which would
  otherwise have left the five workflow suites silently running once.
  
  The spread report is what caught the one caller-facing defect. `roadside-assistance-agent`'s
  `acknowledge_disclosure` carried "after you have read it to them in full" in its
  DESCRIPTION and nowhere else, so a live desk called `lookup_coverage`,
  `acknowledge_disclosure` and `dispatch_truck` while never calling
  `service_disclosure` — a truck went out on a fee nobody read the caller, in the
  one template whose stated purpose is a price they were told about before it
  moved. `service_disclosure` records the handover now and `acknowledge_disclosure`
  refuses without it.
  
  Eight template prompts had real defects, most of them one shape: an instruction
  to ANNOUNCE a lookup with no instruction to then perform it (topic-briefing,
  executive-inbox in three places), a tool the prompt never mentioned at all
  (entertainment-picks' `recommend`), an escape hatch that literally permitted
  answering uncited (web-research), reading a score conflated with awarding points
  (text-adventure), a clarifying question asked over an already-complete objective
  (research-planner), no positive counterpart to "never invent a value"
  (hotel-reception), and every fee figure handed to the model behind a rule
  forbidding it to summarise them (roadside `lookup_coverage`).
  
  Several evals were wrong rather than the agents: three asserted values a SCRIPT
  determined against a live model, two forbade a documented-valid outcome, one
  demanded three distinct scores from three separate `ctx.generate` calls that
  never see each other, and several read a multi-tool chain out of a single turn.
  `EvalTestContext.mode` now carries the rule that would have prevented the first
  three — a value a script determined may only be asserted under `mode === "stub"`.
  
  Three new exports on `@alexkroman1/aai-runtime/eval`, moving that capability to
  epoch 2 with epoch 1 retained: `expectCalled` names the tier's commonest finding
  (the agent announced and stopped) in one assertion message that quotes the
  sentence said in place of the tool; `lastToolResultIn` is `toolResultIn` without
  the exactly-once refusal, which is right within a turn and wrong across turns;
  and `EvalWorkflowEngineOptions.stepAttempt` lets a case reach a body's PRIMARY
  branch — the engine only ever answered a first-and-only attempt, so
  `isLastAttempt` was always true and `link-digest`'s degraded prompt was the only
  one any eval had measured.

## 0.0.1

### Patch Changes

- d98169a: Lint the docs workspace. It was excluded from Biome twice over — `docs/**` was
  absent from `files.includes`, and no invocation pointed at it — and had no
  `lint` script, so `turbo run lint` resolved `aai-docs#lint` to `<NONEXISTENT>`
  and `pnpm check` skipped it silently. That is the failure AGENTS.md already
  names for a package with no `lint` script, one workspace over.
  
  Latent rather than live, because the workspace holds zero TypeScript: what was
  unlinted is the four config JSONs, including the `typedoc.json` and
  `typedoc.markdown.json` whose options the docs guide calls load-bearing. Both
  carry explanatory comments, so a Biome override allows comments in
  `docs/typedoc*.json` — Biome's built-in JSONC filename list covers
  `turbo.json` and `tsconfig.json` but not these.
