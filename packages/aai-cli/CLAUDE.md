# packages/aai-cli — CLI guide

The `aai` CLI (`@alexkroman1/aai-cli`). Repo-wide conventions live in the root
`CLAUDE.md`; the studio surface the CLI round-trips against is documented in
`packages/aai-studio-server/CLAUDE.md`.

## Commands and exports

Binary: `aai` — subcommands: init, dev, test, build, eject, list, pull, push,
publish, delete, login, secret, storage, workflow, templates.

**`aai workflow` talks to the AGENT, not to the platform API** (`workflow.ts`,
`cli-workflow.ts`): `list`, `runs <name>`, `show <runId>`, `cancel <runId>` over
the brokered `/:slug/workflows` surface. It is deliberately NOT an `apiRequest`
— that surface takes the agent's own bearer (`AAI_WORKFLOW_API_TOKEN`, passed as
`--token`) or none at all, so sending the caller's platform API key there would
be both useless and a leak. Every request BROKERS, so the first one may boot the
agent's sandbox; that is the same trade the studio's runs card makes and worth
knowing before scripting a loop around it. `--limit` is parsed in the command
rather than the executor, so a non-numeric value fails as a CLI error naming the
flag instead of as a query the agent rejects three hops away.

The requests are the SDK's (`createWorkflowApiClient`,
`@alexkroman1/aai/workflow-api`); what stays here is turning "this directory"
into an origin plus a PUBLISHED slug, and printing. One consequence to know
because it is the one place the two ends disagree: `api.get` resolves
`undefined` for a 404 — right for a page racing a run it just started, and
nothing for `show` to print — and that status ALSO covers "this agent serves no
workflow API", so the failure sentence claims neither cause and the shared
`HINT_BROKER` names all three.

**`aai eject` is a retrofit, not the self-hosting path.** Self-hosting is the
DEFAULT now: the scaffold ships `server.mjs` plus a `prestart`/`start` pair, so
every project `aai init`/`aai pull` produces already runs with `npm start` — no
platform account, nothing managed (see `packages/aai-templates/CLAUDE.md`).
`eject` exists only for projects that predate that and are missing the two
files. It COPIES `server.mjs` out of the resolved scaffold rather than writing
its own contents: two definitions of the entrypoint would drift, and the one
nobody runs locally is the one that would rot. An existing `scripts.start` is
left alone even under `--force` — that flag is about replacing the entrypoint
file, and silently rewriting the command a project boots with is a larger act.

**`aai build` LEAVES its worker on disk** (`.aai/worker.mjs`, beside the built
client), and that is what `npm start` boots — so the CLI is a build-time
dependency of self-hosting rather than absent from it, which the paragraph above
used to claim outright. The reason is tool discovery: `worker-bundler.ts`
enumerates `tools/` and emits the imports, so a loader that reads `agent.ts`
directly serves an agent with none of its tools and nothing reports it. `eject`
therefore writes `prestart` as well as `start`, and writes it only alongside a
`start` it wrote — bolting a build onto someone else's start command changes
what that command does. The two constants (`PRESTART_SCRIPT`, `START_SCRIPT`)
are a second definition of the scaffold's scripts and `eject.test.ts` pins them
against it.

**`bin.mjs` is the bin in BOTH layouts** — the source checkout (where it loads
`cli.ts`) and the published tarball (where only `dist/` ships, so it loads
`dist/cli.mjs`); there is no `publishConfig.bin` override any more. One wrapper
for both is what makes `module.enableCompileCache()` reachable: the cache only
covers modules compiled AFTER the call, and every CLI dependency is external
(`deps.neverBundle`), so `dist/cli.mjs` carries hoisted imports for citty,
execa and the rest — all evaluated before any statement inside it. A banner, or
a first line in `cli.ts`, would cache nothing that costs anything; loading the
entry through a DYNAMIC import from a wrapper is the only ordering that puts
the enable genuinely first. Source wins when both are present, so a built
checkout under `pnpm link --global` still runs the working tree.

**`aai test` sets no `NODE_OPTIONS`.** It used to force
`--experimental-strip-types`, which is redundant on every Node the CLI supports
(`>=24`; stripping is default-on since 23.6, and in Node 26 the flag survives
only as an alias for `--strip-types`). Not free, either: `NODE_OPTIONS`
propagates into every vitest worker, so a value that ever stopped being
accepted would fail the whole run rather than degrade.

**There is no user-facing deploy.** Source always flows through the studio
workspace and production always comes from Publish: `aai push` replaces the
linked project's workspace file map atomically
(`PUT /studio/projects/:project/source`, fast-forward-checked against the
`studioSourceHash` recorded in `.aai/project.json` — a 409 means the studio
edited since the last pull; `--force` overwrites), `aai publish` pushes then
runs the studio's Publish route (the in-sandbox `aai deploy`), syncing
`.env` into the agent's secrets via the standard secret routes (before the
deploy when the slug already exists, after it on a first publish), and
`aai pull <project>` materializes a workspace locally, layering the shipped
scaffold underneath (never overwriting workspace files) so the result runs
under `aai dev`. **package.json is MERGED rather than skipped**
(`mergeScaffoldManifest` in `aai-cli/_templates.ts`): the scaffold fills in
top-level fields the pulled manifest lacks, and for `dependencies` /
`devDependencies` / `scripts` it fills in per ENTRY. Skip-if-exists was wrong
here because a studio workspace's manifest declares its runtime deps and NO
toolchain — correct in the guest, where the toolchain is baked (see
`ensureProjectShape`), and fatal on a laptop, where `pnpm install` then
fetched no `vite`, `@vitejs/plugin-react`, or `@tailwindcss/vite` and
`aai dev` died resolving the vite.config.ts the same layering had just
written. Per-entry matters both ways: the workspace's exact pins survive the
scaffold's carets, and one agent-added devDependency can't shadow the whole
toolchain block. `aai delete` in a linked directory deletes the STUDIO
PROJECT (`DELETE /studio/projects/:project`), which cascades server-side to
the workspace, chat, and the project's deployed + preview agents — and
CLEARS the link fields from `.aai/project.json`, keeping `serverUrl`. Left
behind, they sent the next push a `baseHash` for a project that no longer
existed: a 409 whose hint said to run `aai pull`, which then failed with
"No studio project named …", so only `--force` recovered. The
hidden `deploy` subcommand remains only because the guest's Publish
(`aai-guest/studio-publish.ts`) executes it; a bare `aai` in a project
offers to publish, and `aai init` publishes after scaffolding.

**A pull that finds nothing PRINTS THE PROJECT LIST.** "No studio project
named X" has two causes and the list is the only thing that separates them: a
typo has the user's other projects beside it, while an EMPTY list means this
login is scoped to a different account than the studio the project lives in
(studio scope follows the account that owns the API key — see
`packages/aai-server/CLAUDE.md`), so the hint says so and points back at
`aai login`. The extra request is on an already-failing path and its own
failure must never replace the 404, so it degrades to the old "run `aai list`"
hint.

**A workspace carries UTF-8 text only.** Both snapshots — the CLI's
`collectSourceFiles` and the guest's `snapshotWorkspace` — decode with
`TextDecoder({ fatal: true, ignoreBOM: true })` and SKIP a file that isn't
valid UTF-8, warning by name, exactly as the byte cap does. The file map is
JSON, so a lossy `"utf-8"` read turned a pushed PNG into U+FFFD while
reporting success, and a later `aai pull` wrote the mangled bytes back over
the local original. `ignoreBOM` is load-bearing: the decoder strips a leading
BOM by default, so the check meant to stop corruption would introduce a
smaller version of it. Skipped files also ride the JSON result as `warnings`,
because `log.warn` is silenced in JSON mode and JSON mode is auto-detected on
a pipe — a scripted push otherwise reported plain success while having
replaced the workspace with a truncated tree.

**A LONG-RUNNING command's diagnostics go through `notify` (`_ui.ts`), not
`log`.** `silenceOutput()` no-ops every `log` method so JSON mode's contract —
exactly one result line on stdout — holds. That is right for a
request/response command and wrong for `aai dev`, which writes its JSON line at
startup and then keeps running: every later message was silenced for the rest of
the process, including "Restart failed: … (previous server still running)", the
watcher's ENOSPC/EMFILE error, and the `unhandledRejection`/`uncaughtException`
handlers whose entire purpose is diagnostics. Since JSON mode is AUTO-DETECTED
on a pipe, that is the NORMAL case — `aai dev > dev.log`, a process supervisor,
a container — so a syntax error left the previous agent being served with
nothing anywhere saying why edits had stopped taking effect (verified: stderr
empty, stdout one line, old version still served). `notify` keeps the styled
clack output in human mode and writes a plain line to STDERR once silenced, so
the stdout contract survives while a human tailing the log still sees the
failure. Any new post-startup output in a long-running command owes the same
treatment.

**`aai dev`'s restart state machine lives in `_dev-restart.ts`, behind
injected `build`/`listen`/`close` operations.** It is the subtlest part of the
watch loop — an edit saved mid-boot must QUEUE rather than race the initial
build, a change during an in-flight restart must loop once more with the
newest files, a failed build must leave the old server serving, the new server
must be built BEFORE the old one closes (the down-window is the swap, not the
rebuild), a lost port race must retry, and teardown must be idempotent and win
against a rebuild in flight. None of that touches chokidar, Vite, or the
bundler, but while it was inlined in `startDevServer` the only way to reach it
was through nine module mocks plus a REAL bundler build and the watcher's 300ms
debounce per assertion — which is why those specs carried 15s `vi.waitFor`
ceilings, and why four of the races above had no test at all. Keep new
restart/teardown logic in `_dev-restart.ts` and spec it there
(`_dev-restart.test.ts`, no mocks); `_dev-server-restart.test.ts` is for
WIRING only — that a chokidar event reaches the supervisor and that teardown
closes the watcher with the server.

One rule the split made visible and is worth keeping: **reporting success sits
outside the `listen` try/catch.** Inside it, a notifier that throws — stderr
closed by `aai dev | head` — was reported as a failed listen and tore down a
server that had already bound. Logging must not be able to take the dev server
down.

**`viteDevConfig`'s proxy table is the whole agent API as the BROWSER can see
it under `aai dev`** — with a `client.tsx`, Vite owns the port the user is told
to open and answers everything not in that table itself, with a bare 404
carrying none of the agent server's headers. So the failure reads as a missing
route, not a missing proxy entry, and it is invisible to every test that talks
to the backend port directly. **A route added to `createServer` that a page
fetches must be added there too.**

`/workflows` is the case that proves the rule and the one it was learned from.
A WORKFLOW APP (`workflowApp()`, i.e. `page: "static"`) has no session and no
socket:
`page()` renders a form and every single thing it does — listing workflows to
build that form, starting a run, polling it, streaming its events — is a
same-origin fetch under that prefix. Unproxied, both workflow-app templates
were dead on arrival under `aai dev` (`404 POST /workflows/runs` the instant
the form is submitted) while the backend served the whole API correctly one
port over. A string key prefix-matches, so the one entry covers `/runs`,
`/runs/:id` and the `/runs/:id/events` SSE stream. The DevKit's own
`/.well-known/workflow/v1/{flow,step}` callbacks deliberately stay out: those
are dialled by the guest's own worker on loopback, never by a browser, which
is the same `guest-internal` distinction `aai-server/guest-routes.ts` draws.

**A step bundle carries a `createRequire` shim, and without it a CJS dependency
kills the process at load.** `workflow-bundler.ts` prepends two lines to
`stepCode`. esbuild cannot statically rewrite `require("node:assert")` inside a
bundled CommonJS module, so it emits a `__require` whose fallback THROWS
`Dynamic require of "node:assert" is not supported` — and a step bundles
everything it imports, so any step reaching a package with CJS anywhere in its
graph died before its first line ran. The shim's own mechanism is that esbuild
writes `typeof require !== "undefined" ? require : <thrower>`, so a real
`require` in scope is used; it is PREPENDED because it must precede the
`var __require = …` initializer that reads it. The flow bundle deliberately
gets none — it is compiled in a `node:vm` Script, where `import.meta` does not
exist.

Two things about how it presented are the reusable part. `research-workflow`
imports `webSearch` from `@alexkroman1/aai/tools`, which reaches `host/ssrf.ts`
→ **undici** (118 dynamic requires, all `node:` builtins) — so the message named
a Node builtin the author never mentions, nothing named the package or the
import that pulled it in, and because the step bundle loads before the server
binds there was no server to ask. And it does NOT reproduce in-tree, where
`@dev/source` resolves the SDK to TypeScript and esbuild initializes a different
set of CJS modules eagerly: the same bundle imports cleanly with no shim.
Every gate short of `check:e2e` was green. `workflow-bundler.test.ts` therefore
asserts the ORDERING rather than the throw, which is the half that is checkable
here.

**Both Vite entry points dedupe React** (`DEDUPED_PEERS`, `_vite-env.ts`) and
the two symptoms look nothing alike, which is why the dev half was missing for
so long. `buildClient`'s is a publish that dies with *"Rolldown failed to
resolve import react/jsx-runtime"*; `viteDevConfig`'s is a project whose SDK is
LINKED rather than installed — `aai init` run inside this monorepo, i.e. how a
template gets tested by hand — loading two physically distinct copies of the
same React version, so every hook throws *"Invalid hook call"*, `ThemeProvider`
unmounts, and the agent renders a BLANK PAGE naming no package. An
npm-installed project is correct either way, which is exactly what kept it
hidden.

**A `*-preview` project name is refused** (`projectNameFromDir` returns
null). Publishing deploys under the project's own name, so such a project
would claim a slug the orphan-preview sweep reaps hourly — taking the agent,
its app-database schema, and its secrets with it. See the `-preview` note in
`packages/aai-server/CLAUDE.md` for the matching deploy-boundary rule.

**The directory name is normalized by the PLATFORM's slugifier**
(`slugifyName`, `@alexkroman1/aai/slugify`), not a local regex. It was a local
`[^a-z0-9-_]` strip for a long time because the studio's copy lived in the
private `aai-server`, which the CLI may not import — and the two disagreed on
exactly the names people give agents: `Café Ordering/` pushed as
`caf-ordering` while typing the same name into the studio produced
`cafe-ordering`, so one human name made two projects depending on which path
created it. The visible change from adopting it is that `_` now collapses to
`-` (`my_agent/` → `my-agent`); the slug GRAMMAR still permits `_`, so a slug
the user requests outright is unaffected.

## Key files

- `cli.ts` — arg parsing, subcommand dispatch
- `_cli-common.ts` — shared citty plumbing (`sharedArgs`, `setup`,
  `runCommand`); `_studio-commands.ts` — the list/pull/push/publish command
  definitions
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` (internal) / `delete.ts` /
  `secret.ts` — subcommand entry points
- `studio.ts` / `_studio.ts` — the studio round-trip: pull/push/publish
  executors over the `/studio/projects` routes, the local source walk
  (the walk, caps, skip rules and strict UTF-8 decode all come from
  `@alexkroman1/aai/workspace-files`, shared with the guest's end-of-turn
  sync; lockfiles never sync in EITHER direction, and `.env` is the one rule
  this side still adds — the guest keeps `.env` visible because the coding
  agent may have written it)
- `_init.ts` / `_deploy.ts` / `_delete.ts` / `_bundler.ts` — internal logic
- `_dev-server.ts` — dev server for directory-based agents: loads `agent.ts`,
  builds runtime, watches for file changes, optionally runs Vite for client HMR
- `_dev-restart.ts` — the watch loop's restart state machine (see below)
- `_bundler.ts` — bundles `agent.ts` (and optional `client.tsx`) into
  deployable artifacts
- `_api-client.ts` — platform API client (`apiRequest`, `apiRequestOrThrow`)
- `_config.ts` — auth config, project config, API key management;
  `project-config.ts` re-exports its two WRITERS (`writeConfigHome`,
  `updateProjectConfig`) as a public subpath. That exists for the studio
  guest, which materializes a workspace into a real project and spawns this
  CLI against it (`aai-guest/studio-publish.ts`) — it hand-wrote both files
  with `JSON.stringify`, so the shapes matched the schemas the CLI parses
  them back with by coincidence, and neither of the properties that matter is
  visible in the JSON: the config home is 0600 via atomic rename (an older
  world-readable file is TIGHTENED, not left), and the project pin is MERGED
  (`.aai/project.json` also carries the studio link fields). Keep it a thin
  re-export — the point is one writer per format, not a nicer one
- `_agent.ts` — agent discovery, dev mode detection, server URL resolution
- `_utils.ts` — shared utilities (`resolveCwd`, `fileExists`)
- `_server-common.ts` — shared server utilities
- `_templates.ts` — template handling
- `_ui.ts` — CLI output helpers (`log`, `fmtUrl`, `parsePort`)

## Fault mode: a suite run against a server that keeps dying

`AAI_FAULT_PROFILE=<name>` makes every test that boots its server through
`startSupervisedDevServer` (`_fault-mode.ts`) run against an `aai dev` child that
is **SIGKILLed and restarted** at declared points. Unset, the helper is the plain
spawn it replaced, so the normal suite is unchanged.

```sh
AAI_FAULT_PROFILE=restart-on-boot pnpm test:e2e     # the whole suite, under faults
node --run test:integration                          # unaffected without the var
```

Five things about it are load-bearing.

**The kill is a SIGKILL, and nothing else would do.** A graceful stop lets
graphile-worker's runner release the queue locks it holds — which is precisely
the difference that decides whether an in-flight step is ever redelivered. So a
fault mode built on SIGTERM would exercise the recovery path that already works
and never the one that does not. (Measured: one hard kill of the process, or of
its Postgres, strands every locked step permanently — nothing reclaims a lock by
age — with the run sitting `running` forever.)

**There is no seed and no PRNG, deliberately.** "Consistent" is the requirement,
and the cheapest way to be consistent is to have nothing to reproduce: a profile
is an ordered list of points keyed on logical events, so the Nth kill lands after
the same observed event on every machine at every speed. Wall-clock kills are
what `tmp/transcribe-load/chaos.mjs` does and why its runs cannot be compared.
Randomized exploration is a different job for a different tool — this repo drives
every randomized suite with fast-check so nobody hand-rolls a seventh PRNG, and
a seed here would be that seventh.

**A profile that matches nothing FAILS LOUDLY.** `awaitSettled()` throws naming
the points that never fired plus the last lines the server wrote, and `stop()`
warns when a profile injected zero. Without that, a renamed log line turns the
whole mode into a no-op and the suite passes "under faults" having injected none
— the failure this repo keeps paying for, a gate reporting success while checking
nothing.

**`afterHealthy` exists because a log trigger cannot reach the boot.** `aai dev`
announces itself with `log.success`, which JSON mode SILENCES — and JSON mode is
what the e2e suite runs and what a pipe auto-selects. The first boot profile was
keyed on a startup line, matched nothing, and was caught by the paragraph above
on its first real run. Workflow lines are unaffected: the agent server's logger
writes straight to stderr rather than through `log`, so `"Workflow run started"`
survives JSON mode and is a fine trigger.

**Assert from `awaitSettled()`, not from the boot.** It resolves once every
declared kill has happened AND the survivor answers `/health`, which is the only
moment "the faults are done and the server is back" is true; a request issued
before it races a restart window. `assertPlanConsumed()` is the stricter version,
for a test whose SUBJECT is the profile — a test merely running under one should
not fail because a step-level trigger never fired in a test that runs no
workflow. That is also why `restart-on-boot` is the profile to run a whole suite
under: every supervised server boots, so its triggers reach every test.

`AAI_FAULT_PROFILE` is declared in the `check:e2e` and `check:integration` `env`
in `turbo.json`, for both halves of the documented strict-env-mode rule: an
undeclared variable is stripped before the task starts (so the command above
would run with no faults and say nothing), and a fault run must not share a cache
entry with a clean one — or the first green clean run serves a FULL TURBO for
every later fault run and the mode tests nothing.

It is **not wired into CI** yet, and the reason is a real finding rather than
caution. An in-flight step is never redelivered after its process (or its
Postgres) is hard-killed: the queue job keeps `locked_by` a worker that is gone,
graphile-worker's `get_job` selects on `is_available = true`, and the run sits
`running` for good: `is_available` is a generated column over `locked_at` with no
time term, so nothing reclaims it. So a profile that kills DURING a run is red
today for a reason this mode surfaced rather than caused, and a
required check would be red with it. `restart-on-boot` is the one that is green,
because it kills between runs.

What CI runs is `_fault-mode.scenario.test.ts` — the supervisor's own spec,
driven against a fake server (including one that prints nothing at all), because
a mode whose whole job is to inject faults has to be shown to inject them.

### The other fault mode lives in `aai`, and faults a SOCKET

`packages/aai/host/_fault-socket.ts` is the sibling of this one: a TCP proxy that
SEVERS live connections, for testing that a session continues across a
disconnect. It sits in `aai` rather than here because what it faults —
`createServer`, the WebSocket upgrade, session resume — lives there.

Three things separate the two, and picking the wrong one measures nothing:

- **This mode kills a PROCESS; that one cuts a CONNECTION.** They are not
  degrees of the same fault. A workflow survives a process restart because its
  state is in Postgres; a voice session survives only PARTLY, and the split is
  worth knowing before choosing a mode. Its slot state is durable when the app
  has a database (`aai/host/session-state-store.ts`), so a reconnect recovers the
  cart — but the session and sink maps are still plain `Map`s in `runtime.ts` and
  the transport holds live provider sockets, a turn machine and an audio pacer,
  none of which has a representation to store. So a socket drop remains the only
  disconnect a SESSION is advertised to survive; what a restart now preserves is
  the state, not the call.
- **It severs rather than closing.** `destroy()`, never a close frame: a clean
  close is the "user hung up" case aai-ui deliberately does NOT reconnect from,
  so a test built on `ws.close()` proves the opposite of what it looks like.
  `session-resume.scenario.test.ts` asserts the client observes **1006** for
  exactly that reason.
- **It is a proxy for the same reason this one is a supervisor.** The sockets are
  server-side, so the obvious shape is an env-gated `ws.close()` inside
  `createServer` — a fault injector in production code, able to fire in
  production. A proxy in front is test-only by construction.

## Bundling rules

- **Vite must not be allowed to mutate `process.env`.** Vite's `build()`
  sets `NODE_ENV=production` when it is unset — a permanent, global side
  effect on the calling process. Both CLI bundlers therefore wrap the
  build in `withPreservedNodeEnv` (`aai-cli/_vite-env.ts`), which
  snapshots and restores it. Without that, `aai dev`, which rebuilds on
  every file change, flips itself to "production" on the first rebuild.
  Keep any new Vite invocation inside that wrapper.
- **Builds and deploys are TYPE-CHECKED.** `aai build` and `aai deploy`
  run the project's own `tsc --noEmit` (`aai-cli/typecheck.ts`, gated on a
  `tsconfig.json`, `--skipTypecheck` opts out), and the guest's
  `test_agent` build does the same before bundling — the bundlers strip
  types unchecked, which is exactly how the `send`/`state`
  runtime-working-but-wrong bugs shipped. Type errors reach the studio's
  coding agent as build/deploy output it can act on. The dev watch loop
  deliberately does NOT typecheck (editor/CI feedback is faster there).

  **It passes `--singleThreaded`, which is a SPEEDUP, not a throttle.** TS 7
  parallelizes parse/check/emit by default — worth it on a repo-sized program,
  a net cost on the single agent project this function always checks. Measured
  on the templates project (the closest in-repo analogue of a studio
  workspace): **pinned to 1 core, 2.4–2.9s parallel vs 1.2–1.4s single**; on 4
  cores, 1.21s vs 1.01s. The 1-core figure is the one that matters, because a
  guest RESERVES one CPU and this same check runs after every settled write
  burst in the studio, where the design rests on it finishing in well under a
  second — parallelism inside a one-core reservation is oversubscription.
  Gated on the resolved compiler's major >= 7: an unknown compiler option is a
  HARD error (TS5023), so a project pinning an older TypeScript must degrade,
  not fail on a flag it never asked for.
- **`buildClient` runs with no `client.tsx` → `{}`** → the agent gets the
  default UI.
- **`buildClient` dedupes React** (`resolve.dedupe`), because `aai-ui`
  declares it as a *peer* dependency while the bundler resolves the bare
  `react/jsx-runtime` inside `aai-ui/dist/**` from *that file's* real path.
  Locally aai-ui's own devDependency satisfies it; a pruned production
  install can leave the build root's walk-up copy as the only React —
  reachable from the workspace root but not from `packages/aai-ui/dist`.
  Publishing died with *"Rolldown failed to resolve import
  react/jsx-runtime"* while every local build passed.
  `aai-cli/client-bundler.test.ts` guards this (every non-optional aai-ui
  peer is deduped). The Modal image installs the full workspace (dev deps
  included), so the old pruned-image packaging tests are gone with the
  Dockerfile.

## CLI credential destinations (`aai-cli/_agent.ts`)

`.aai/project.json` is in the working tree, so a cloned repo controls its
`serverUrl` — and `aai deploy` / `aai secret` pair that URL with the user's API
key and secret values. `resolveServerUrl` therefore honors a config-supplied
origin only when it is the shipped default or already in `approvedServers` in
the user-owned global config. Loopback origins are deliberately NOT implicitly
trusted from config — a repo-supplied `http://localhost:<port>` would hand the
key to whatever is listening on that local port (dev mode targets its own
default server before the project config is consulted, so `aai dev` workflows
are unaffected). Passing `--server` is what approves an origin (it is user
intent, not repo content) and is remembered for later commands. Never widen
this to trust `serverUrl` directly.

**`aai secret` follows the project when the directory is linked**
(`secretRequest` in `_slug-api.ts`): a studio project deploys a preview agent
as well as a production one, so a secret set against the deployed slug alone
left the preview — one this CLI's own `aai publish` created — failing at its
first session. A linked directory therefore targets
`/studio/projects/:project/secret`, which fans out server-side; an unlinked
one keeps the per-slug route, which is the platform primitive. `aai publish`'s
`.env` sync does the same.

The `slug` from the same file is validated against the platform's slug shape
(`VALID_SLUG_RE`, shared with aai-server via `@alexkroman1/aai/utils` —
`sdk/slug.ts` is the single definition) before it is ever
interpolated into a URL path, so a hostile `"slug": "x/../admin"` cannot steer
a credentialed request; `aai secret delete` also URL-encodes the secret name.
**That check lives in `resolveDeployTarget`** — the one point where
repo-controlled config becomes a credentialed target — so every command
inherits it. It used to live in `getServerInfo` only, which covered
secret/storage/delete but NOT `publish`, whose `syncEnvSecrets` PUTs the whole
`.env` to `${serverUrl}/${slug}/secret`; one guard in two places, with the
copy missing from the command users actually run.

The API key itself is stored 0600 in the global `config.json`
(`AAI_CONFIG_DIR` overrides the config dir location).
**`ensureApiKey` has exactly ONE source: the key `aai login` saved.** Neither a
"paste a key" prompt nor an `ASSEMBLYAI_API_KEY` env var authenticates the CLI.
Both produced the same thing — a CLI that could push, publish, and read/write
another account's secrets while linked to no account the user could see in the
studio, and an `aai login` that was optional in practice. The env var was the
worse of the two: it applies to every invocation in a shell, it PERSISTED
itself into the global config on first use (so the CLI stayed authenticated as
that key long after the export was gone), and it collides with what the same
name means in a project `.env`, where it is a *provider* credential for the dev
server rather than a platform identity. The prompt was separately the riskier
code path: a hidden password prompt reads stdin, so a piped invocation could
have its input eaten and persisted as the API key. Unauthenticated commands
fail with `not_logged_in` pointing at `aai login`; non-interactive callers (CI,
scripts, the eval harnesses) point `AAI_CONFIG_DIR` at a config dir holding a
logged-in key, which is what `aaiEnv()` seeds for the e2e suite's spawned CLIs.

**Every global-config update goes through `updateGlobalConfig`, which holds a
cross-process lock.** `writeJson` makes each write atomic (temp file + rename),
so no reader sees a torn file — but the read→modify→write SPAN is not atomic and
every writer replaces the whole document, so concurrent invocations lose each
other's updates. Measured: 8 parallel commands each approving a distinct origin
recorded only 5, and a concurrent `approveServer` straddling the final write of
`aai login` DISCARDS THE API KEY — the login prints "your API key is saved" and
the next command says `not_logged_in`. The window is wide open in practice,
because `aai login` polls for up to five minutes while the user approves in the
browser, so anything else run in that time can be mid-update when the key lands.
The lock is a `wx` exclusive-create lockfile with three deliberate properties:
acquisition is **bounded** (on timeout the update proceeds UNLOCKED rather than
throwing — failing a login on a stuck lockfile is worse than the lost update),
a **stale** lock is broken (a process killed mid-update must not send every later
write down the unlocked path forever), and it must **never nest** (re-entry
self-deadlocks until the timeout; `executeLogin` calls `approveServer` and the
key update in sequence, not nested). `.aai/project.json` deliberately keeps the
last-write-wins behaviour — it is per-directory, not shared across every command
and terminal.

**`aai dev` is the one command a shell-exported key still reaches, and only as
a provider credential.** `resolveAgentEnv` (`_dev-server.ts`) falls back to the
login key only when NEITHER `.env` nor the shell carries one — otherwise
exporting the key the usual way would hard-fail with `not_logged_in`. The
exported value deliberately never enters `ctx.env`: it reaches the resolvers
through `withHostCredentialFallback` (the same documented ergonomic every other
provider key gets), and `agentEnvWarnings` flags it as shell-only so the "works
here, dead after deploy" case stays visible.

**Tests must never resolve the real config dir.** `getConfigDir()` returns a
per-process temp dir whenever `VITEST` is set (unless `AAI_CONFIG_DIR` says
otherwise), and `aaiEnv()` sets `AAI_CONFIG_DIR` for the CLIs the e2e suite
spawns. The guard is in the code path, not a vitest setup file, because
setup files are per-config and any config can omit one — `vitest.slow.config.ts`
(integration + e2e) declared none, so `_test-setup.ts` never ran for those
suites and real configs accumulated ~100 approved loopback origins plus
`https://override.com`. That matters because `approvedServers` is the trust
anchor for a repo-supplied `serverUrl`: a pre-approved loopback origin lets a
cloned repo's `.aai/project.json` collect the developer's API key and secret
values with no prompt, which is exactly what the loopback tightening above
removed. Spawned CLI children run with `VITEST` cleared (or the CLI skips
`main()`), so both halves are needed.

Note that `aai build`, `aai dev`, and `aai deploy` all evaluate the
repository's bundled `agent.ts` in the host process (`evalWorkerBundle` /
`evalWorkerConfig`, via a temp-file import) — running any of them against an
untrusted clone executes that repo's code locally. A bare `aai` in a project
still asks for confirmation on a TTY before implicitly deploying.

**`aai deploy` evaluates deliberately, and it is a smaller delta than it
sounds.** It used to upload without importing, because the platform extracted
the config guest-side; that extraction is gone (see "The platform stores no
agent config" in `packages/aai-server/CLAUDE.md`), so the CLI is now the only
place that can read `__aaiConfig` — which it needs for the credential
preflight (`_preflight.ts`), and whose import doubles as the deploy's smoke
test. The same command already executed repo-controlled
code regardless: `buildAgentBundle` does NOT pass `configFile: false` (only
the guest's untrusted-workspace builds do), so the project's `vite.config.ts`
runs at build time either way.
