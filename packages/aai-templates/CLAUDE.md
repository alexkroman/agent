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
