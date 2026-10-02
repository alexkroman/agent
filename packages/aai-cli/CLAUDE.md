---
summary: >-
  Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`),
  bundling + Vite rules, credential destinations, `aai dev`'s server and host
  mode, self-hosting (`npm start`) and `aai build --target`
read_when: >-
  changing an `aai` subcommand, the bundler, or where the CLI sends a key
---

# packages/aai-cli — CLI guide

The `aai` CLI (`@alexkroman1/aai-cli`). Repo-wide conventions live in the root
`AGENTS.md`; the studio surface the CLI round-trips against is documented in
`packages/aai-studio-server/CLAUDE.md`.

**Directory guides:** none. `src/` is flat (every module is a sibling), so
there is no subdirectory a scoped guide could govern; this file is the whole
guide. It is not shipped: `package.json` `files` is `bin.mjs` + `dist`.

## Commands and exports

Binary: `aai` — subcommands: init, dev, console, start, test, eval, build,
list, pull, push, publish, delete, login, secret, logs, workflow, templates.

That list is pinned to the registry by `cli.test.ts` ("the subcommand list in
this package's guide names exactly what `cli.ts` registers"); `deploy` is
hidden (in-guest Publish is its only caller) and excluded.

### `aai eval` is a separate command from `aai test`

A test asserts about the config and calls no model; an eval drives a real
session, costs money, and is probabilistic — so it stays out of the command a
project runs on every save and in `aai build` (`eval.ts`).

- **The two are disjoint by construction.** A positional to `vitest run` is a
  substring FILTER over vitest's own include matches, so `agent.test.ts` cannot
  match `agent.eval.test.ts`. Neither command names the other's files.
- **The shared launcher is `_vitest-runner.ts`**, not `test.ts`, so `eval`
  does not import from the other command's file. Each tier's filenames stay
  with its command (`TEST_FILES` in `test.ts`, `EVAL_FILES` in `eval.ts`);
  `candidates` has no default so the runner never names a tier.
- **It passes `--testTimeout`** (`EVAL_TEST_TIMEOUT_MS`, 5 min): vitest's 5s
  is shorter than one model turn; the harness's 90s per-turn timeout diagnoses.
- **It hands the project's `.env` to the child** via `resolveServerEnv`
  (declared keys only, shell wins), or every case skips for want of a key.

The harness is published from `@alexkroman1/aai-runtime/eval`, including what
a keyless run does (not "skip") — see "Driving an agent from text is a
published surface" in `packages/aai-runtime/CLAUDE.md`.

### `aai test` runs the PROJECT's specs, and a narrowed run is honest about it

A narrowed run must never report a green verdict over specs it skipped.

- **`executeTest` covers every non-eval spec by default.** `--only`
  (`TestOptions.only`) narrows to `agent.test.ts`; `warnUnrunSpecs` names the
  skipped files (ten, then a count) and the result says `complete: false`.
  `incomplete_run` FAILS for one arm only: `--only` in a project with no
  `agent.test.ts` but other specs.
- **The result carries the set** — `cli-test-data-carries-the-set` and
  `cli-eval-data-carries-the-set` in `konsistent.json` require
  `ran`/`unrun`/`complete` on `TestData` and `ran` on `EvalData`.
- **`aai build` runs the whole suite**
  (`runVitest(cwd, { candidates: TEST_FILES, all: true })`); `--skip-tests` is
  the honest opt-out.
- **`runVitest` announces the unrun set itself** (`announceUnrun`, default
  `true`). `aai test` passes `false` (its result reports it); `aai eval` passes
  `false` (the unrun set is a test-tier claim).
- **The scaffold's `test` script is `aai test`**, and `test:agent` is
  `aai test --only`: the command a project wires into CI must run its suite.
  If an exclude is ever needed, vitest's CLI `--exclude` is appended to
  `defaultExclude`, not a replacement.
- **`aai test` sets no `NODE_OPTIONS`** — type stripping is default-on for the
  supported Node (`>=24`), and `NODE_OPTIONS` reaches every worker, so a bad
  value fails the whole run.

### `aai console`, `aai workflow`, `aai logs`

**`aai console` is `connectSession` with a microphone** (`console.ts`,
`_console-session.ts`, `_console-audio.ts`): one in-process session over a
`ClientSink`, the agent loaded as `aai dev` does — no server, socket or browser.

- **SoX subprocesses (`rec`/`play`), not a native addon**; a missing binary
  fails as `audio_device` naming the install command.
- **A barge-in kills and respawns `play`** (a pipe cannot discard its buffer).
  Lead is 400 ms, not the browser's 1500.
- **A FATAL `error.reported` ends the command.**
- **In JSON mode the conversation goes to stderr** (stdout owes one line).
- No echo cancellation — it tells the user to wear headphones.

**`aai workflow` talks to the AGENT, not the platform API** (`workflow.ts`,
`cli-workflow.ts`): `list`, `runs <name>`, `show <runId>`, `cancel <runId>`
over the brokered `/:slug/workflows` surface. **Never an `apiRequest`**: that
surface takes the agent's own bearer (`AAI_WORKFLOW_API_TOKEN`, `--token`) or
none, so sending the platform API key would leak it. Every request brokers (may
boot the sandbox). `--limit` is parsed in the command so a bad value names the
flag. Requests are the SDK's `createWorkflowApiClient`; `api.get`'s
`undefined` on 404 also means "no workflow API", so `HINT_BROKER` lists all
three causes.

**`aai logs` reads a RING, so `--follow` polls** (`logs.ts` →
`GET /:slug/logs`, the guest's bounded buffer with a cursor — see
`packages/aai-guest/src/harness/CLAUDE.md`). It must say that the ring dies with
the sandbox, distinguish `running` from `lines.length`, and print `dropped`. A
failed poll under `--follow` is not a failed command; only a signal ends it.
`--json` reports the line count, not the lines.

### Command plumbing

- **Every leaf command is `defineExec({ cwd, args, meta, run })`**
  (`_cli-common.ts`). `cwd` is a required working-directory policy: `"agent"`
  (refuses a directory without `agent.ts`), `"any"`, or `"none"` (body gets
  `cwd: undefined`, typed). Keep the lazy `await import` of the executor in
  each body — it keeps a subcommand's deps off every other startup. Group
  commands (`secret`, `workflow`) are plain citty `defineCommand`s.
- **A returned `fail(...)` and a thrown error converge on one emitter keyed on
  `result.ok`**, never on the code path (else a returned failure exits 1 silently).
- **A 2xx body is CHECKED, not cast** (`checkedResponse`, `_api-client.ts`):
  `apiRequest<T>` is a cast, and a proxy's 200 once wrote `slug: undefined`
  into `.aai/project.json`. The predicate is the caller's; the helper owns
  `bad_response` + hint.
- **All terminal I/O goes through the `Ui` seam (`_ui.ts`)**, never clack,
  `console.*` or `process.stdout`: `defineExec` hands `ctx.ui` to the body;
  executors take `ui` (default `defaultUi`, which published `/start` keeps).
  Specs pass `createFakeUi()` (`_test-utils.ts`), never a `vi.mock` of `_ui.ts`
  or clack; collaborators are seams too (`DevServerSeams`, `ConsoleSeams`,
  `PlatformDeps`, `VitestDeps`, `InitDeps`).
- **A long-running command's post-startup output is `ui.notify`**: `silence()`
  no-ops `log` in JSON mode (a pipe auto-selects it); `notify` then writes
  plain stderr. Restart failures, watcher errors, crash handlers,
  `resolveAgentEnv`'s warnings.
- **`--help` is grouped** (`HELP_SECTIONS`, `_help.ts`; `cli.test.ts` places
  every visible subcommand once) and says what bare `aai` does. **Flags are
  kebab-case**; camelCase still parses, unadvertised.
- **Pre-parse failures honour JSON mode too.** `usageForMode` and
  `assertKnownFlags` run in the `runDefault().then(assertKnownFlags)` chain
  before `defineExec`, so a new guard there owes an explicit
  `getOutputMode({})` branch. `cli.test.ts` covers it by running the real bin
  with stdout piped.
- **`aai init` with no `--template` picks one** (`promptTemplate`, a select
  over `listTemplates()`, `quickstart-agent` first). **Never without a human**:
  `--yes` and `silent` (JSON mode) resolve `DEFAULT_TEMPLATE`; the specs
  asserting `select` was NOT called are the point.
- **`bin.mjs` is the bin in both layouts** (source → `cli.ts`, tarball →
  `dist/cli.mjs`; source wins). A wrapper's dynamic import is the only ordering
  that runs `module.enableCompileCache()` before the dependencies load.

## The studio round-trip

There is no user-facing deploy: source flows through the studio workspace and
production comes from Publish.

- **`aai push`** replaces the linked project's file map atomically
  (`PUT /studio/projects/:project/source`), fast-forward-checked against
  `studioSourceHash` in `.aai/project.json`; 409 = the studio edited since the
  last pull, `--force` overwrites.
- **`aai publish`** pushes, syncs `.env` into the agent's secrets (always
  before the deploy, first publish included), then runs the studio's Publish
  route (the in-sandbox `aai deploy`). A bare `aai` in a project offers to
  publish and confirms on a TTY first.
- **`aai pull <project>`** materializes a workspace and layers the scaffold
  underneath, never overwriting workspace files. **`package.json` is MERGED**
  (`mergeScaffoldManifest`, `aai/src/host/scaffold-layer.ts`, shared via
  `@alexkroman1/aai/workspace-files`): top-level fields fill if absent, and
  `dependencies`/`devDependencies`/`scripts` fill per ENTRY — a studio manifest
  carries no toolchain (it is baked in the guest), and per-entry keeps the
  workspace's exact pins.
- **A pull that finds nothing prints the project list** (a typo shows other
  projects; empty means another account's login — `packages/aai-server/CLAUDE.md`).
  The extra request never replaces the 404; it degrades to "run `aai list`".
- **`aai delete` in a linked directory deletes the STUDIO PROJECT**
  (`DELETE /studio/projects/:project`, cascading server-side) and clears the
  link fields from `.aai/project.json`, keeping `serverUrl` — stale link fields
  make the next push unrecoverable without `--force`.
- **`layerScaffold` substitutes the scaffold's `CLAUDE.md`** with a ~30-line
  pointer at `node_modules/@alexkroman1/aai/AGENT_GUIDE.md`
  (`PROJECT_GUIDE_POINTER` has the argument). Matched on full path — a
  template's own `CLAUDE.md` is still copied.
- **A workspace carries UTF-8 text only.** Both snapshots (`collectSourceFiles`
  here, the guest's `snapshotWorkspace`) decode with
  `TextDecoder({ fatal: true, ignoreBOM: true })` and SKIP non-UTF-8 files,
  warning by name. `ignoreBOM` is load-bearing (the default strips a BOM).
  Skips also ride the JSON result as `warnings`, since `log.warn` is silent
  there.
- **Lockfiles never sync in either direction**; `.env` is the one extra rule
  this side adds (`studio.ts`/`_studio.ts`; the walk, caps and decode come from
  `@alexkroman1/aai/workspace-files`).
- **`aai init` scaffolds and stops** — no publish, no `--server`, no
  `--skip-deploy` (now an unknown flag via `findUnknownFlags`). `init.test.ts`
  asserts it makes no `fetch`.
- **A dev-mode `aai init` links EVERY `@alexkroman1/*` the scaffold names**
  (`WORKSPACE_PKG_DIRS`, `_init.ts`). The spec in `init.test.ts` derives the
  expected set from `scaffold/package.json` with a floor — never hand-list it.
- **A `*-preview` project name is refused** (`projectNameFromDir` → null): the
  orphan-preview sweep would reap it. See the `-preview` note in
  `packages/aai-server/CLAUDE.md`.
- **Directory names go through the platform's `slugifyName`**
  (`@alexkroman1/aai/slugify`), never a local regex, so the CLI and studio agree
  (`my_agent/` → `my-agent`).

## `aai dev`

- **The restart state machine is `_dev-restart.ts`**, behind injected
  `build`/`listen`/`close`: an edit mid-boot queues, a change mid-restart loops
  once more, a failed build keeps the old server, the new server is built before
  the old one closes, a lost port race retries, and teardown is idempotent and
  beats an in-flight rebuild. Spec new logic in `_dev-restart.test.ts` (no
  mocks). The wiring specs take fakes through `DevServerSeams`
  (`makeDevSeams`, `_dev-server-test-utils.ts`), not module mocks.
- **Coalescing is `createCoalescingRunner`**, not a local flag pump. The boot
  window is a separate flag released by `adopt`; `restartOnce` returns early
  once `closed`.
- **Reporting success sits outside the `listen` try/catch** — a throwing
  notifier (`aai dev | head`) must not tear down a bound server.
- **`viteDevConfig`'s proxy table (`_dev-vite-config.ts`) is the whole agent
  API as the browser sees it** — with a `client.tsx`, Vite owns the port and
  answers anything unlisted with a bare 404. **It is DERIVED from
  `SERVER_ROUTES`** (`ws: true` per ws row, the `fileServedByVite` bypass per
  prefix HTTP row, `root` skipped), so a route belongs in that table, never in
  a hand-added proxy key; `_dev-server-serve.test.ts` asserts every row but
  `root` is proxied. `/workflows` is one prefix entry covering runs, run reads
  and the SSE stream (workflow apps are dead without it).
  `/.well-known/workflow/v1/*` stays out (platform/third-party callers, never a
  browser), which is why `aai dev` hands `createRuntime` the BACKEND origin as
  `publicUrl`.
- **Both Vite entry points dedupe React** (`DEDUPED_PEERS`, `_vite-env.ts`).
  Missing in dev, a LINKED SDK (`aai init` inside this monorepo) loads two
  React copies and renders a blank page ("Invalid hook call").
- **Bundling bugs may not reproduce in-tree**: `@dev/source`, pnpm links and
  realpath resolution give a different module graph from an installed SDK, and
  only `check:e2e` sees the installed shape. Assert the checkable half (an
  ordering, a shape) rather than the throw. There is no separate workflow
  bundle; workflow bodies run as ordinary code in the worker bundle.
- **ffmpeg under `aai dev` is whatever is on `PATH`**, or
  `AAI_FFMPEG_PATH`/`AAI_FFPROBE_PATH` (or `FFMPEG_PATH`/`FFPROBE_PATH`); a
  deployed guest always has it (see "ffmpeg is installed, and a step reaches it
  through the SDK" in `packages/aai-guest/CLAUDE.md`). ENOENT is reported as
  "ffmpeg is not installed…", `ffmpegVersion()` answers `undefined` so a step
  can preflight, and the CLI never installs or requires one.

## The client build's default plugins, and Fast Refresh

A project with a `client.tsx` and no `vite.config.*` gets `react({ exclude })` +
`tailwindcss()` from `_client-plugins.ts`, loaded from the PROJECT's
`node_modules` (walked by hand: `createRequire` also reads pnpm's `NODE_PATH`);
missing ones fail `client_plugins_missing`. A project `vite.config.*` wins
whole. `aai init` drops the UI deps (`CLIENT_ONLY_DEPENDENCIES`, `_init.ts`)
from a project with no `client.tsx`; `vite` stays (vitest, `vite/client`).

- **`REACT_REFRESH_EXCLUDE` must keep `dist/` and `client.tsx`.** A LINKED
  `aai-ui` resolves outside `node_modules`, so its bundled chunks became
  refresh boundaries and a rebuild threw
  `Session hooks must be used within <SessionProvider>`; `client.tsx` exports
  nothing and re-running it double-mounts. `exclude` REPLACES the plugin's
  `node_modules` default.
- **Do not** use `optimizeDeps.include: ["@alexkroman1/aai-ui"]` or
  `resolve.preserveSymlinks` (silent staleness; the latter also two Reacts).

## `aai dev --tunnel`, `AAI_DEV_SOURCE`, `secret put --local`

- **`--tunnel`** (`_dev-tunnel.ts`): cloudflared quick tunnel (binary
  `AAI_CLOUDFLARED_PATH` or `PATH`, never installed) to the PRINTED port; its
  URL becomes `PUBLIC_URL` before the first build. `--on-public-url <cmd>` runs
  with the URL once up and with it EMPTY on exit; a failing hook warns. The
  tunnel dying exits 1. The scrape excludes `api.trycloudflare.com` (a failed
  request logs it).
- **`AAI_DEV_SOURCE=1`** (`_dev-source.ts`): a `link:`ed SDK runs from `src/`.
  `bin.mjs` adds `@dev/source` to Node's conditions (source CLI only);
  `devSourceViteConfig` adds it to every Vite build, beside Vite's defaults
  (`conditions` replaces them). Opt-in: in-repo suites spawn the source CLI and
  assert the BUILT shape. The default UI still comes from `aai-ui/dist`.
- **`--local`** on `secret put`/`delete` edits `<cwd>/.env` via
  `_dotenv-file.ts`, round-tripped through `parseEnv` (last assignment wins,
  multi-line values, mode kept, new file 0600, atomic rename).

## Running the SDK's own server (`aai dev` and host mode)

`createServerForRuntime` (`packages/aai-runtime/src/server/server.ts`) is `aai dev`'s
backend; with no `AAI_SESSION_SECRET` it authenticates no one, so both
defaults fail closed.
This package owns `AAI_DEV_HOST`, `hostModeEnv` and `resolveServerEnv`;
`packages/aai/CLAUDE.md`, "Self-hosted server defaults" has the summary.

- **Binds loopback.** `listen(port, host = DEFAULT_LISTEN_HOST)` is
  `127.0.0.1`; pass `"0.0.0.0"` deliberately. `aai dev` exposes `AAI_DEV_HOST`
  for containers.
- **`AAI_SESSION_SECRET` gates `aai dev`, which mints its own client's ticket
  into `GET /client-config`** (`_dev-session-ticket.ts`, which says why resume
  ownership is waived); a self-hosted server never does.
- **Host mode is opt-in.** A `?host=1` WebSocket lets the client supply the
  agent definition while spending the operator's credentials, so
  `isHostAllowed` requires `AAI_ALLOW_HOST` of `1`/`true`/`yes`/`on`.
  `aai dev` passes the shell value through (`hostModeEnv`), since
  `resolveServerEnv` surfaces only `.env` keys.
- **A host client may bring its own provider credentials.** The handshake's
  `credentials` record is merged over the server env for that connection and
  WINS, so a server holding only `AAI_ALLOW_HOST` spends only callers' keys.
  `createHostServer` (`aai-runtime/server/host-server.ts`, whose module doc has
  the argument) is that server in one call; `defaults` excludes the four
  handshake-owned fields; `examples/host-server` is the runnable shape.
- **The credential allowlist is a security boundary.** Names are screened
  against `ALL_PROVIDER_ENV_VARS`, checked against the SERVER's env before the
  merge. Unbounded, a client could set `DATABASE_URL` (workflow world, upload
  store, session-state backend on its own Postgres) or `AAI_ALLOW_HOST`.
  Unknown names are REJECTED by name, never dropped.
- **A host session with no base agent runs the DEFAULT PIPELINE, not S2S**:
  with no `hostBaseAgent`, one `ASSEMBLYAI_API_KEY` covers STT, LLM gateway and
  TTS.
- **Host-mode audio pacing is the client's declaration and defaults to
  paced** (`HostConfig.audioLeadMs`: omitted = `CLIENT_AUDIO_LEAD_MS`, number
  = that lead, `null` = unpaced). Unpaced, an S2S reply bursts into the
  client's buffer and a barge-in discards it unheard; paced,
  `PacedAudioSink.clear()` drops the server-side backlog. `null` is only for a
  harness faster than real time (tau2 is not).

## Bundling rules

- **Nothing scans a workflow body for replay-unsafe calls** (`Date.now()`,
  `Math.random()`, `fetch(`…) — a known gap. A replacement must work off the
  source of `workflows/*.ts`, outside every `ctx.step(…)` callback, and stay a
  warning where attribution is undecidable.
- **Vite must not mutate `process.env`** — `cli-vite-build-preserves-node-env`
  in `konsistent.json` requires every `*-bundler.ts` to call `build()` through
  `withPreservedNodeEnv` (`_vite-env.ts`). A Vite call in any other filename
  must use the wrapper by hand.
- **Builds and deploys are type-checked.** `aai build` and `aai deploy` run the
  project's `tsc --noEmit` (`typecheck.ts`, gated on a `tsconfig.json`,
  `--skip-typecheck` opts out); the guest's `test_agent` does too. The dev watch
  loop deliberately does not. **`--singleThreaded` is a speedup** for one small
  project on the guest's one reserved CPU; it is passed only when the
  compiler's major is >= 7 (older TypeScript rejects the unknown option,
  TS5023).
- **`buildClient` with no `client.tsx` returns `{}`** → default UI.
- **`buildClient` dedupes React** (`resolve.dedupe`): `aai-ui` declares React
  as a peer, and a pruned install can leave it unresolvable from
  `aai-ui/dist/**`. `client-bundler.test.ts` requires every non-optional
  `aai-ui` peer to be deduped.

## `aai build` warns about a COMPUTED step name

`_workflow-determinism.ts` scans `workflows/*.ts` for a
`ctx.step`/`ctx.sleep`/`ctx.waitFor` whose identity is a template literal;
`build` and `deploy` print one line per finding with the remedy. It is
`guard-invariants` rule 32 pointed at a user's project. The types miss it:
`Literal<Name>` refuses `string`, but a template literal has a template-literal
type.

- **It WARNS, not fails** (a `const`-string interpolation is legitimate). On
  `deploy` findings join `warnings` so studio Publish sees them.
- **Rule 30's read-scan half is deliberately not ported**: it is all false
  positives on user code without a real parse, and a native parser cannot join
  the CLI's runtime deps (artifact-size budget).
- **False-positive floor:** `_workflow-determinism.test.ts` requires ZERO
  findings over every shipped template, with the template count floored.
- **The pattern is duplicated from the gate script** (neither can import the
  other); a test reads `IDENTITY_CALLS` from the gate's source and probes this
  module with each name.

## CLI credential destinations (`aai-cli/_agent.ts`)

`.aai/project.json` is in the working tree, so a cloned repo controls its
`serverUrl` — and `aai deploy` / `aai secret` pair that URL with the user's API
key and secret values. `resolveServerUrl` therefore honors a config-supplied
origin only when it is the shipped default or already in `approvedServers` in
the user-owned global config. **Loopback origins are NOT implicitly trusted
from config** — a repo-supplied `http://localhost:<port>` would hand the key to
whatever listens there (dev mode targets its own default server before the
project config is consulted, so `aai dev` is unaffected). **Passing `--server`
is what approves an origin** (user intent, not repo content) and is remembered.
**Never widen this to trust `serverUrl` directly.**

- **The `slug` from `.aai/project.json` is validated** against `VALID_SLUG_RE`
  (`@alexkroman1/aai/utils`; `sdk/slug.ts` is the single definition) before it
  is interpolated into a URL, so `"slug": "x/../admin"` cannot steer a
  credentialed request. **The check lives in `resolveDeployTarget`** — the one
  point where repo config becomes a credentialed target — so every command,
  including `publish`'s `.env` sync, inherits it. `aai secret delete`
  URL-encodes the secret name.
- **`aai secret` follows the project when the directory is linked**
  (`secretRequest`, `_slug-api.ts`): linked → `/studio/projects/:project/secret`
  (fans out to production and preview agents); unlinked → the per-slug route.
  `aai publish`'s `.env` sync does the same.
- **The API key is stored 0600 in the global `config.json`** (`AAI_CONFIG_DIR`
  overrides the dir).
- **`ensureApiKey` has exactly ONE source: the key `aai login` saved.** No
  paste-a-key prompt and no `ASSEMBLYAI_API_KEY` env var authenticates the CLI:
  either would let it push/publish and read/write secrets as an account the
  user cannot see in the studio; the env var would persist itself and collides
  with the project `.env`'s provider credential; a hidden prompt can eat piped
  stdin as a key. Unauthenticated commands fail `not_logged_in` → `aai login`.
  Non-interactive callers (CI, scripts, evals) point `AAI_CONFIG_DIR` at a
  logged-in config dir, as `aaiEnv()` does for e2e.
- **Every global-config update goes through `updateGlobalConfig`**, holding a
  cross-process `wx` lockfile, because read→modify→write loses concurrent
  updates (including the key during `aai login`'s five-minute poll). The lock
  is **bounded** (on timeout, proceed UNLOCKED rather than fail a login),
  **breaks stale locks**, and must **never nest** (`executeLogin` calls
  `approveServer` and the key update in sequence). A lock that cannot be broken
  (a directory, permission-denied) falls through to the unlocked path — never
  `continue` above the deadline check. `.aai/project.json` stays
  last-write-wins (per directory).
- **`aai dev` is the one command a shell-exported key reaches, and only as a
  provider credential.** `resolveAgentEnv` (`_dev-agent-env.ts`) falls back
  to the login key only if neither `.env` nor the shell has one. The shell
  value never enters `ctx.env`: it goes through `withHostCredentialFallback`,
  and `agentEnvWarnings` flags it shell-only.
- **Tests must never resolve the real config dir.** Under `VITEST`,
  `getConfigDir()` returns a per-process temp dir (unless `AAI_CONFIG_DIR` is
  set); `aaiEnv()` sets it for spawned CLIs (`VITEST` cleared). The guard is in
  the code path because a config can omit a setup file, and a polluted
  `approvedServers` would let a cloned repo collect the developer's key.
- **`aai build`, `aai dev` and `aai deploy` execute the repo's code locally**
  (`evalWorkerBundle` / `evalWorkerConfig`, and the project's `vite.config.ts`
  since `buildAgentBundle` does not pass `configFile: false` — only the guest's
  untrusted builds do). Running them on an untrusted clone runs that code.
  `aai deploy` imports its bundle for the credential preflight (`_preflight.ts`,
  since the platform stores no agent config — see "The platform stores no agent
  config" in `packages/aai-server/CLAUDE.md`), doubling as a smoke test.

## Self-hosting and `aai build --target`

`aai start` (`start.ts`) is the self-hosting command and runs the BUILT worker
(`.aai/worker.mjs`, produced by the scaffold's `prestart`); `--target` emits a
per-host entry into build output. The rules — target detection, the deploy-env
warning, the Vercel/Deno/Modal emits, the Node/Deno/Bun certification and the
Bun floor, and why there is no runtime `tools/` scan — are in
`SELF-HOSTING-CLAUDE.md` beside this file.

## Fault mode: a suite run against a server that keeps dying

`AAI_FAULT_PROFILE=<name>` makes every test that boots via
`startSupervisedDevServer` (`_fault-mode.ts`) run against an `aai dev` child
that is **SIGKILLed and restarted** at declared points; unset, it is a plain
spawn.

```sh
AAI_FAULT_PROFILE=restart-on-boot pnpm test:e2e     # the whole suite, under faults
```

- **SIGKILL only** — a graceful stop releases graphile-worker's locks and
  skips the recovery path under test.
- **No seed, no PRNG**: points are keyed on logical events, so runs are
  reproducible. Randomized exploration uses fast-check elsewhere.
- **A profile that matches nothing FAILS**: `awaitSettled()` throws naming
  unfired points plus recent server lines; `stop()` warns on zero injections.
- **`afterHealthy` exists because JSON mode silences `aai dev`'s boot line**;
  workflow log lines go straight to stderr and are valid triggers.
- **Assert from `awaitSettled()`** (all kills done and `/health` answers).
  `assertPlanConsumed()` is for tests whose subject is the profile.
  `restart-on-boot` is the whole-suite profile.
- `AAI_FAULT_PROFILE` is declared in `check:e2e` and `check:integration` `env`
  in `turbo.json` (strict env mode, and separate cache entries).
- **Not in CI**: a hard-killed in-flight step is never redelivered
  (graphile-worker's `is_available` has no time term), so mid-run profiles are
  red for a real reason. CI runs `_fault-mode.scenario.test.ts`, the
  supervisor's own spec against a fake server.

### The other fault mode lives in `aai-runtime`, and faults a SOCKET

`packages/aai-runtime/src/server/_fault-socket.ts` is a TCP proxy that SEVERS live
connections, to test session resume. Choose correctly:

- **This mode kills a PROCESS; that one cuts a CONNECTION.** A restart
  preserves durable slot state (`aai-runtime/session-state/store.ts`) but not the
  call; a socket drop is the only disconnect a session survives.
- **It severs (`destroy()`), never closes** — a clean close is "user hung up",
  which aai-ui does not reconnect from; `aai-runtime/src/server/session-resume.scenario.test.ts`
  asserts **1006**.
- **It is a proxy** so no fault injector lives in production code.

## `run_code` under `aai dev` / `aai start` is OPT-IN: `AAI_RUN_CODE=deno`

Off the platform there is no container, so `run_code` refuses
(`RUN_CODE_REFUSAL`) rather than evaluating model-written code in this process.
`AAI_RUN_CODE=deno` in the PROCESS env (never the agent's `.env`, for
`AAI_CHANNEL_OUTBOX`'s reason) makes `_run-code-deno.ts` hand the runtime an
executor that runs each snippet as its own `deno` with no `--allow-*` flag:
`--no-prompt` turns every file/net/env/run/ffi/sys request into a `NotCapable`,
the code goes on stdin only, the child env is three fixed entries
(`DENO_DIR`, `DENO_NO_UPDATE_CHECK`, `NO_COLOR`), and the process group is
killed at 5s. The binary is `AAI_DENO_PATH`, else the first `deno` on `PATH`,
probed for 2.x once at boot; enabled but missing, it warns once and keeps
refusing. `aai start` passes it through `AgentServerOptions.runCode`.

**Deno loads a LOCAL module without read permission** — `import s from
"/x.json" with { type: "json" }` printed the file under `--deny-read` — so the
argv carries an import map sending every `file:` URL to a host `--no-remote`
refuses. The module doc lists every flag and why;
`_run-code-deno.scenario.test.ts` proves each denial against a real `deno`
(skipping, announced, without one; `AAI_REQUIRE_DENO` makes that a failure).

## The e2e suite is pnpm-only in CI

`e2e.test.ts` installs an `aai init` project from a mock verdaccio registry.
CI runs pnpm only; `publint` + `attw` cover non-pnpm `exports` resolution.
`AAI_TEST_PM` (`_e2e-test-utils.ts`, in `check:e2e`'s `env`) switches the
install to reproduce a user report — a debugging tool, not covered ground:

```sh
AAI_TEST_PM=npm pnpm test:e2e
```

**`AAI_REQUIRE_REGISTRY`**, also in `check:e2e`'s `env`, disables the
`isRegistryProxyFailure` excuse for a failed install; CI sets it.

## Windows is NOT tested, and is currently broken

No `os` field is declared, so the packages claim Windows by omission. A
one-off `windows-latest` run found two causes:

- **Hardcoded `/tmp` literals** (drive-relative on Windows) — fixed; kept out
  by `guard-invariants` rule 11 (baseline: `modal/agent-sandbox.ts`'s remote
  paths, which are in the Linux sandbox).
- **The `aai` build emits unbundled `.ts` specifiers on Windows** (rolldown
  `UNRESOLVED_IMPORT` on `./_internal-types.ts`) — UNRESOLVED, a tsdown/rolldown
  difference that needs a Windows machine.

**Do not re-add a Windows matrix without a Windows machine to reproduce on,
and never as `continue-on-error`** — a leg green while broken is worse than
none. The scenario/integration tiers are Linux-by-design.

## Key files

- `cli.ts` — arg parsing, dispatch; `_cli-common.ts` — `defineExec`,
  `sharedArgs`, `setup`, `runCommand`; `_studio-commands.ts` —
  list/pull/push/publish definitions
- `init.ts`, `dev.ts`, `test.ts`, `eval.ts`, `deploy.ts` (internal),
  `delete.ts`, `secret.ts` — entry points
- `_vitest-runner.ts` — the vitest launcher shared by `test`, `eval` and
  `build`, the spec inventory, and the unrun-spec notice
- `studio.ts` / `_studio.ts` — pull/push/publish over `/studio/projects`
- `_dev-server.ts` — `aai dev`: loads the agent, builds the runtime, watches,
  optionally runs Vite; `_dev-vite-config.ts` — `viteDevConfig`;
  `_dev-restart.ts` — restart state machine; `_dev-watch.ts` —
  `watchDirectory`, `isIgnoredPath`, the `DevWatchFn` seam
- `_bundler.ts` — bundles `agent.ts` (and `client.tsx`)
- `_api-client.ts` — `apiRequest`, `apiRequestOrThrow`, `checkedResponse`
- `_config.ts` — auth/project config, API key. `project-config.ts` re-exports
  its two writers (`writeConfigHome`: 0600 via atomic rename, tightening an
  older file; `updateProjectConfig`: merges) for the studio guest
  (`aai-guest-studio/publish.ts`). Keep it a thin re-export — one writer per
  format.
- `_agent.ts` — agent discovery, dev mode, server URL resolution
- `_utils.ts` (`resolveCwd`, `fileExists`), `_server-common.ts`,
  `_templates.ts`, `_ui.ts` (`Ui`, `defaultUi`, `fmtUrl`, `parsePort`),
  `_help.ts` (grouped `--help`)
