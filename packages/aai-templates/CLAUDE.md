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
| `workflow()` + `ctx.workflows` + `isTerminal` | `research-desk` (the handoff — start a run, correlate it with `key`, read it back), `transcription-desk` (the fan-out, plus `cancel` and `WorkflowOutputOf`) — the two templates with a `workflows/` directory (see below) |

**`research-desk` is the workflow template, and its shape is dictated by the
Workflow DevKit rather than chosen.** The `"use workflow"` / `"use step"` bodies
live in `workflows/research.ts` because the WDK builder scans that directory at
build time and rewrites what it finds; a body written in `agent.ts` is never
transformed, so it runs inline once with no durability and nothing saying so.
`agent.ts` holds only the declaration (`workflow({ description, input, run })`)
and the two tools that start and read runs.

Its spec stubs `ctx.workflows` rather than driving a real one, which is the only
honest option: the real client needs a WDK world, and the bodies are only durable
after the build has transformed them. That is also why **`workflow()` does not
check for the compiler's `workflowId`** — `templates.test.ts` imports every
`agent.ts` through vitest with no bundler in the path, so a declaration-time
throw made this template unimportable by its own spec. The check lives at
`ctx.workflows.start`, where the id is actually needed.

Note the template needs `workflow` as a devDependency of THIS package to
resolve at test time; a scaffolded project gets it as a real dependency.

**`transcription-desk` is the second workflow template, and it exists for the
rule a straight-line body cannot show: the DevKit correlates a journal entry to
a step call by the ORDER the call was ISSUED in.** `createUseStep`
(`@workflow/core/dist/step.js`) stamps each invocation with
`step_${ctx.generateUlid()}` from a monotonic ULID factory seeded off the run's
`startedAt` and the VM's replay-stable `Math.random`, so the Nth step call in a
run gets the Nth id on the first execution and on every replay. The step's NAME
is only cross-checked against that id, and a mismatch is `ReplayDivergenceError`
rather than a silent re-run.

Two things follow, and they are the template's whole content:
`Promise.all(batch.map(step))` is safe (every call issued synchronously, in
array order, whatever order they settle in), and **a work-stealing pool is not**
— a worker issues its next call only after its previous one settles, so the
issue order tracks completion order, which differs between a live run and a
replay. Bounded concurrency therefore has to be sequential batches of
`Promise.all`, which costs the tail of each batch and is the only deterministic
option. This is the one piece of the pre-DevKit engine's API that did NOT
survive the port: `ctx.step("chunk-3", …)` let a caller pin identity to a
position, and nothing replaces it.

It also demonstrates that a fan-out's WIDTH may come from a step's result
(`splitRecording`), because that result is journaled — as against anything the
body computes for itself, which is the ordinary determinism rule one level up.

Its spec additionally exercises the BODY directly, which `research-desk`'s does
not: imported through vitest with no bundler in the path, `transcribeFlow` is an
ordinary async function and its `"use step"` calls are ordinary calls, so the
assembly (every chunk in recording order, no dropped partial final batch) is
testable while durability and replay are not. The spec says so in place, because
a body test that looked like a durability test would be the worse failure.

**A step cannot reach `ctx.env` or `ctx.db`, which is why both workflow
templates stub their I/O.** A `"use step"` function is bundled and dispatched
separately from the agent bundle and is handed no tool context, and the guest
reads the agent's secrets into memory rather than into `process.env`
(`harness-agent-mode.ts` deletes the env file after reading). So there is
currently no way for a step to authenticate an outbound call, and
`research-desk`'s comment that `ctx.db` is "available in a step" describes an
intent rather than the implementation. Until that gap is closed, a template's
steps are fixtures.

The one thing a template may still hand-roll here is a **fallback that would
cost the browser bundle**: `retail`'s client builds its empty view from a
seedless `emptyRetailState()` instead of `retailSlot.projection(storeView)
(undefined)`, because the slot's factory pulls a 107 KB `seed.json` and
importing it would ship the whole catalog to the browser. It says so in place.

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
