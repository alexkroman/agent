# packages/aai-templates — templates guide

Agent templates + the project scaffold (private package). Note
`scaffold/CLAUDE.md` is a PRODUCT artifact — it is scaffolded into every
`aai init` project and embedded in the studio system prompt — not
documentation for this repo.

## Templates

- `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and optional `client.tsx`.
  `scaffold/` has base project files (package.json, tsconfig,
  etc.) layered underneath.

  **They ship inside the `@alexkroman1/aai-cli` tarball**, copied into its
  `dist/` at build time by `aai-cli/bundle-templates.mjs` — the sources stay
  in `aai-templates`, which still owns their tests, typecheck, and lint;
  this is packaging, not a move. `aai init` used to fetch them at run time
  with giget (`github:alexkroman/agent/packages/aai-templates#main`), which
  required a network for every init and pinned templates to `main`
  regardless of the CLI version installed, so a template written against a
  newer SDK could land in a project resolving an older one. Two consequences
  worth knowing:
  - `packages/aai-cli/turbo.json` adds the template sources to the build's
    `inputs`. They live in another package, so the root task's
    package-relative globs cannot see them — without the override, editing a
    template replays a cached CLI build that predates it.
  - Nothing running in-tree can exercise the shipped path: `getMonorepoRoot()`
    keys off the module's own location, so a CLI built at
    `packages/aai-cli/dist` always finds the workspace root and takes the
    monorepo branch. The e2e suite's `detachedCli()` copies `dist/` somewhere
    with no `pnpm-workspace.yaml` above it for that reason, and `aaiEnv()`
    deliberately sets no `AAI_TEMPLATES_DIR` — that override used to pin
    every e2e run to the workspace sources.

## The scaffold pins `^<newest>`, so it must opt out of release-age quarantine

`scripts/sync-scaffold-versions.mjs` resyncs `scaffold/package.json` to the
workspace versions on every `changeset version`, so a scaffolded project always
asks for the SDK release that was just cut. That is correct — the templates are
written against it — but it collides with pnpm's `minimumReleaseAge`, which
holds a version back until it has been on the registry for N minutes (pnpm 11
turns it on by default; an org config can set it far higher). Because this repo
publishes several times a day, EVERY version satisfying `^<newest>` is inside
the window, there is nothing older to fall back to, and `aai init` dies at its
own install step with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Lowering the pin
does not help: the floor has to admit the build the templates need.

`scaffold/pnpm-workspace.yaml` therefore ships
`minimumReleaseAgeExclude: ["@alexkroman1/*"]` — scoped to our own packages, not
`minimumReleaseAge: 0`, so a user's window still covers every third-party
dependency. `templates.test.ts` pins both that key and the
`onlyBuiltDependencies`/`allowBuilds` pair beside it, because **every setting in
that file fails only on a user's machine**: pnpm ignores unknown keys silently,
so a rename or a dropped line is invisible in-tree. Reproduce either failure by
copying `scaffold/` to a temp dir, appending `minimumReleaseAge: 10080`, and
running `pnpm install --lockfile-only`.

Do not confuse this with a stale metadata cache, which fails the same command
with a different error: plain `ERR_PNPM_NO_MATCHING_VERSION` and a
`The latest release … is "X"` line naming a version older than the pin. That one
is client-side (`pnpm cache delete "@alexkroman1/*"`), not ours — the quarantine
error always names the constraint or carries a `published by <date>` clause.

## The templates are where SDK primitives get their worked example

`template-api-coverage.test.ts` already enforces the direction "every public
export is exercised by a template". The converse is the rule to apply while
EDITING one: when the same helper appears in a third template, that is the
signal to extract it into the SDK rather than copy it again. Five came out at
once, and the templates are now their reference use:

| Primitive | Demonstrated by |
| --- | --- |
| `sessionSlot()` + `SlotStateOf` | every stateful template — `pizza-ordering` (smallest), `retail` (slot in `store.ts`, view in `shared.ts`, so the seed stays out of the browser bundle) |
| `slot.projection(view)` as `syncState` | `pizza-ordering`, `dispatch-center`, `retail`; `solo-rpg` uses bare `slot.read` (its projection is the identity) |
| `slot.update` (serialized mutation) | `dispatch-center` (every mutating tool, plus an `after` hook that prunes and recalculates the alert level), `retail` (inside `retailTool`, the one caller — which is what keeps `update`'s non-reentrancy unreachable) |
| `ToolFailure` / `isToolFailure` | `retail` (~40 sites, failures propagating through `store.ts` helpers), `dispatch-center` (six) |
| `pushCapped` | `dispatch-center` (incident timeline), `retail` (activity feed), `solo-rpg` (session log), `infocom-adventure` (command history) |
| `createToolContext` (`@alexkroman1/aai/testing`) | the four suites that test tools directly — `dispatch-center`, `pizza-ordering`, `retail`, `solo-rpg` |
| `useAgentState(fallback)` | `pizza-ordering`, `dispatch-center`, `retail`, `solo-rpg` |
| `AutoScroll` | the three custom-chrome clients — `dispatch-center`, `retail`, `infocom-adventure` |

The one thing a template may still hand-roll here is a **fallback that would
cost the browser bundle**: `retail`'s client builds its empty view from a
seedless `emptyRetailState()` instead of `retailSlot.projection(storeView)
(undefined)`, because the slot's factory pulls a 107 KB `seed.json` and
importing it would ship the whole catalog to the browser. It says so in place.

## `transcription-desk` is the WORKFLOW-app example, and it costs one demonstration

It is the only template with `page: "static"` — a page (`page()` +
`createWorkflowApi`) over a journaled workflow, chunking audio in the browser
because the Sync API caps a request at 120 s and the sandbox has no decoder.
See "Workflow apps" in `scaffold/CLAUDE.md` for the shape it teaches.

**A template may ship its OWN `package.json`, and this one is the first that
does.** `layerScaffold` merges the scaffold's manifest UNDERNEATH whatever the
template copied in, per ENTRY for `dependencies`/`devDependencies`/`scripts`
(`mergeScaffoldManifest`), so a template declaring only its extras gets the
scaffold's name, scripts, toolchain and SDK pins filled in around them — and a
dependency only that template needs stays out of every other scaffolded
project. `transcription-desk` uses it for `@ricky0123/vad-web` +
`onnxruntime-web`, which are ~19 MB installed and would otherwise land in all
fifteen. Two things a first-time reader will not guess: declare `"type":
"module"` in it (a nested manifest is a package boundary, so files under it
otherwise resolve as CJS in-repo), and add the same packages to
`aai-templates`'s own `devDependencies` plus `knip.json`'s
`ignoreDependencies` — `templates/**` is knip-ignored, so an import inside one
is invisible to it, which is why `@alexkroman1/aai-ui` was already listed.

**Its browser assets are `?url` IMPORTS, never a CDN or `public/`, and both
alternatives fail in ways only a deploy reveals.** `AGENT_CSP` is `connect-src
'self' wss: ws:`, so a jsDelivr fetch is refused outright; and the platform
routes only `/:slug/assets/*` (`handleClientAsset`), so a file in `public/`
resolves under `aai dev` — where Vite serves the whole project root — and 404s
the moment it ships. A `?url` import satisfies both, because Vite emits into
`assets/`. Note `onnxruntime-web` exports its runtime files at the package
ROOT (`onnxruntime-web/ort-wasm-simd-threaded.wasm`); a `./dist/…` path is
refused by its `exports` map.

**A template's colors come from `useTheme()`, not from Tailwind's palette.**
This one shipped with `border-neutral-300` / `text-neutral-600` / `bg-white` /
`rounded-lg`, which is not "unstyled" — the utilities compile fine — but it is
cool grey furniture on the warm cream page `ThemeProvider` paints under every
client (`#FBF8F2`; the tokens are in `aai-ui/context.ts` and `styles.css`). The
design system reaches a template two ways and it needs both: `useTheme()` for
`bg`/`surface`/`border`/`text`/`primary`, and the `@theme` tokens `font-aai`,
`font-aai-serif`, `font-aai-mono` and `rounded-aai` for type and radius.

The `<input type="file">` is the case with no obvious answer, and it is worth
copying: its button is a PSEUDO-ELEMENT (`::file-selector-button`), so no inline
`style` reaches it and left alone it renders as native OS chrome — the one
control on the page ignoring the system. The theme colors therefore travel as
CSS custom properties for the `file:` utilities to read back, the same mechanism
`aai-ui`'s own `Button` uses to let a `:hover` rule beat an inline declaration.
Bind the object to a named variable typed as `CSSProperties` intersected with a
custom-property record rather than inlining it: a fresh literal in the `style`
prop is excess-property-checked against `CSSProperties`, which declares no
custom properties. `aai-ui`'s `StyleWithVars` is the shape to copy.

**It used to be a VOICE agent that started a run from a tool, and nothing
demonstrates that any more.** `ctx.workflows.start()` / `.get()` from inside a
tool — a turn kicking off durable work and answering the caller in the same
breath — is still fully supported and covered by
`packages/aai/host/workflow-engine.test.ts` plus `sdk/testing.ts`'s
`createToolContext`, which defaults `ctx.workflows` for exactly that test. But
`WorkflowClient` and `WorkflowRunSnapshot` are in
`template-api-allowlist.json` now, and that is the honest record of the gap
rather than a claim that the API is unused. A voice template that starts a run
would close it; nothing here is blocked on one.

## What `tsconfig.json` includes is what gets type-checked

A test file is imported by nothing, so tsc only sees it if `include` names
it — a package guide's worth of files can be silently unchecked. This one had
three: `escape-hatch-scope.test.ts`, `template-api-coverage.test.ts` and
`test-assertion-gate.test.ts` were listed nowhere and type-checked by nothing,
under a comment that describes exactly that failure mode. `include` now globs
`*.ts` (this directory only — `scaffold/` is checked separately by
`check:template-types`, under the scaffold's own looser tsconfig). Verify with
`tsc --noEmit --listFiles`, which prints the program's real file list, or by
injecting a type error into a file you expect to be covered.

## Self-hosting is the scaffold's default

`scaffold/server.mjs` plus `"start": "node server.mjs"` ship in every project,
so **any** project runs on its own with `npm start`: no CLI at run time, no
bundler, no platform account. It is deliberately a FILE rather than a CLI
command — a command is something you have to know exists, and the whole gap it
closes was that `createAgentServer` already made self-hosting one call and
nothing put that call in front of anyone. `aai eject` (see
`packages/aai-cli/CLAUDE.md`) copies this same file into projects that predate
it; that command must never grow its own copy of the contents.

Three things in it are load-bearing, and all three were found by running it:

- **The agent is imported DYNAMICALLY.** Static `import` statements are hoisted
  and evaluated before any statement in the file, so an
  `import agent from "./agent.ts"` at the top would load the agent — and every
  `?raw` import inside it — before `registerHooks` had run.
- **It registers module hooks for `?raw` and attribute-less `.json`.** Those
  are bundler conventions Node does not implement: `?raw` is a Vite thing (Node
  looks for a file literally named `system-prompt.md?raw`) and a bare JSON
  import needs `with { type: "json" }` (TypeScript's `resolveJsonModule` does
  not). Nine templates import `./system-prompt.md?raw` and `retail/store.ts`
  imports `./seed.json` bare, so without the hooks `npm start` worked for four
  templates out of fourteen. An import that DOES carry the attribute is passed
  to Node, whose own handling is correct. **`.ts` needs no hook** — Node strips
  the types itself, which is why there is no build step and no second copy of
  the agent in JavaScript.
- **`ctx.env` and provider credentials come from different places, on purpose.**
  `env` is declared keys only (`.env`, plus `.env.example` as a declaration so a
  container with no `.env` still works, with real environment variables winning
  per key) — the same rule `aai dev` follows, so an agent cannot come to depend
  on a `PATH`-style variable that will not exist after deploy. Provider
  credentials go through `withHostCredentialFallback`, which is what lets
  `docker run -e ASSEMBLYAI_API_KEY=…` work without the key becoming `ctx.env`.
  An empty declared value is DROPPED rather than passed through: a provider
  would authenticate with `""` instead of reporting the credential absent, and
  `.env.example` is full of empty values by design.

`packages/aai-cli/e2e.test.ts` boots `npm start` against a real installed
project (`math-buddy`, chosen for its `?raw` import) and probes
`/health`, `/client-config` and `/`. That tier is the only one that can prove
it: the entrypoint resolves `@alexkroman1/aai-ui`'s prebuilt client through a
real INSTALL and imports `agent.ts` through Node's own type stripping, neither
of which an in-tree test exercises.
