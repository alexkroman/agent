# packages/aai-cli — CLI guide

The `aai` CLI (`@alexkroman1/aai-cli`). Repo-wide conventions live in the root
`CLAUDE.md`; the studio surface the CLI round-trips against is documented in
`packages/aai-studio-server/CLAUDE.md`.

## Commands and exports

Binary: `aai` — subcommands: init, dev, test, build, eject, list, pull, push,
publish, delete, login, secret, storage, templates.

**`aai eject` is a retrofit, not the self-hosting path.** Self-hosting is the
DEFAULT now: the scaffold ships `server.mjs` and a `start` script, so every
project `aai init`/`aai pull` produces already runs with `npm start` — no CLI
at run time, no bundler, no platform account (see
`packages/aai-templates/CLAUDE.md`). `eject` exists only for projects that
predate that and are missing the two files. It COPIES `server.mjs` out of the
resolved scaffold rather than writing its own contents: two definitions of the
entrypoint would drift, and the one nobody runs locally is the one that would
rot. An existing `scripts.start` is left alone even under `--force` — that flag
is about replacing the entrypoint file, and silently rewriting the command a
project boots with is a larger act.

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

**A `*-preview` project name is refused** (`projectNameFromDir` returns
null). Publishing deploys under the project's own name, so such a project
would claim a slug the orphan-preview sweep reaps hourly — taking the agent,
its app-database schema, and its secrets with it. See the `-preview` note in
`packages/aai-server/CLAUDE.md` for the matching deploy-boundary rule.

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
  sync; `.env`/lockfiles never sync — the one rule this side adds)
- `_init.ts` / `_deploy.ts` / `_delete.ts` / `_bundler.ts` — internal logic
- `_dev-server.ts` — dev server for directory-based agents: loads `agent.ts`,
  builds runtime, watches for file changes, optionally runs Vite for client HMR
- `_dev-restart.ts` — the watch loop's restart state machine (see below)
- `_bundler.ts` — bundles `agent.ts` (and optional `client.tsx`) into
  deployable artifacts
- `_api-client.ts` — platform API client (`apiRequest`, `apiRequestOrThrow`)
- `_config.ts` — auth config, project config, API key management
- `_agent.ts` — agent discovery, dev mode detection, server URL resolution
- `_utils.ts` — shared utilities (`resolveCwd`, `fileExists`)
- `_server-common.ts` — shared server utilities
- `_templates.ts` — template handling
- `_ui.ts` — CLI output helpers (`log`, `fmtUrl`, `parsePort`)

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
