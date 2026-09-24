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
- **It passes `--testTimeout`** (`EVAL_TEST_TIMEOUT_MS`, 5 min) — vitest's 5s
  is shorter than one model turn. The useful diagnostic is the harness's own
  90s per-turn timeout.
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
- **`--all` is accepted and does nothing** — old CI pipelines pass it and
  `assertKnownArgv` would otherwise reject them.
- **`aai build` runs the whole suite** (`runVitest(cwd, { candidates:
  TEST_FILES, all: true })`); `--skipTests` is the honest opt-out.
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
`_console-session.ts`, `_console-audio.ts`): loads the agent as `aai dev` does,
builds a runtime in-process and runs one session over a `ClientSink` — no
server, socket or browser.

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
flag. Requests are the SDK's `createWorkflowApiClient`; `api.get` resolves
`undefined` on 404, which also means "no workflow API", so the failure names
neither cause and `HINT_BROKER` lists all three.

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
  `result.ok`**, never on the code path — or a returned failure exits 1 with an
  empty terminal.
- **A 2xx body is CHECKED, not cast** (`checkedResponse`, `_api-client.ts`):
  `apiRequest<T>` is a cast, and a 200 from a proxy/portal/mismatched backend
  once wrote `slug: undefined` into `.aai/project.json` and orphaned an agent.
  The predicate is the caller's; the helper owns `bad_response` + hint.
- **A long-running command's post-startup output goes through `notify`
  (`_ui.ts`), not `log`.** `silenceOutput()` no-ops `log` in JSON mode, which a
  pipe auto-selects (`aai dev > dev.log`); `notify` writes a plain stderr line
  once silenced. Applies to restart failures, watcher errors, crash handlers and
  `resolveAgentEnv`'s credential warnings.
- **Pre-parse failures honour JSON mode too.** `usageForMode` and
  `assertKnownFlags` run in the `runDefault().then(assertKnownFlags)` chain
  before `defineExec`, so a new guard there owes an explicit
  `getOutputMode({})` branch. `cli.test.ts` covers it by running the real bin
  with stdout piped.
- **`aai init` with no `--template` picks one** (`promptTemplate`, a `p.select`
  over `listTemplates()`, `quickstart-agent` first and pre-selected). **The
  picker must never be reachable without a human**: `--yes` and `silent` (how
  JSON mode arrives) resolve `DEFAULT_TEMPLATE`. The specs asserting `select`
  was NOT called are the point.
- **`bin.mjs` is the bin in both layouts** (source → `cli.ts`, tarball →
  `dist/cli.mjs`; source wins when both exist). Loading the entry by dynamic
  import from a wrapper is the only ordering that makes
  `module.enableCompileCache()` run before the (external) dependencies load.

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
- **A pull that finds nothing prints the project list**: a typo shows other
  projects; an empty list means the login belongs to another account (see
  `packages/aai-server/CLAUDE.md`). The extra request must never replace the
  404; it degrades to "run `aai list`".
- **`aai delete` in a linked directory deletes the STUDIO PROJECT**
  (`DELETE /studio/projects/:project`, cascading server-side) and clears the
  link fields from `.aai/project.json`, keeping `serverUrl` — stale link fields
  make the next push unrecoverable without `--force`.
- **`layerScaffold` substitutes the scaffold's `CLAUDE.md`** with a ~30-line
  pointer at `node_modules/@alexkroman1/aai/AGENT_GUIDE.md`
  (`PROJECT_GUIDE_POINTER`, which carries the argument): a copy would go stale
  and a project-root `CLAUDE.md` loads in full every session. Matched on full
  path — a template's own `CLAUDE.md` is still copied.
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
  mocks `executePublish` only to assert it is never called.
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
  mocks). `_dev-server-restart.test.ts` is WIRING only and takes fakes through
  `startDevServer`'s `DevServerSeams` (`watch`, `serve`), not module mocks.
- **Coalescing is `createCoalescingRunner`**, not a local flag pump. The boot
  window is a separate flag released by `adopt`; `restartOnce` returns early
  once `closed`.
- **Reporting success sits outside the `listen` try/catch** — a throwing
  notifier (`aai dev | head`) must not tear down a bound server.
- **`viteDevConfig`'s proxy table (`_dev-vite-config.ts`) is the whole agent
  API as the browser sees it** — with a `client.tsx`, Vite owns the port and
  answers anything unlisted with a bare 404. **A route added to
  `createRuntimeServer` that a page fetches must be added there too.**
  `/workflows` is one prefix entry covering runs, run reads and the SSE stream
  (workflow apps are dead without it). `/.well-known/workflow/v1/*` stays out
  (platform/third-party callers, never a browser), which is why `aai dev` hands
  `createRuntime` the BACKEND origin as `publicUrl`.
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

## `aai dev` must not FAST-REFRESH a prebuilt `dist/`

The fix lives in the project's `vite.config.ts`
(`packages/aai-templates/scaffold/vite.config.ts`), not in
`_dev-vite-config.ts`: this package cannot set it.

- **Trigger: a LINKED SDK.** `@vitejs/plugin-react` excludes
  `/\/node_modules\//`, but a symlinked `aai-ui` resolves to
  `packages/aai-ui/dist/…`, so the plugin treats bundled library chunks as
  project source. A rebuild then hot-updates them, re-executing `context.js` and
  throwing `Session hooks must be used within <SessionProvider>`. npm installs
  never hit it.
- **The library cannot fix it**: a bundled chunk mixes components and
  constants, so every file is an invalid refresh boundary.
- **`client.tsx` must not be a boundary either** — it exports nothing, so a
  refresh re-runs `mountClient()` on an existing root before reloading anyway. A
  component in its own file does refresh.
- **Do not** use `optimizeDeps.include: ["@alexkroman1/aai-ui"]` (a rebuild
  then produces no dev-server event: silent staleness) or
  `resolve.preserveSymlinks` (same staleness plus duplicate React).
- This package cannot set the exclusion: `vite:react:refresh-wrapper` reads
  `include`/`exclude` from the `react()` closure, so only the call site can.
  Don't add a reload debounce; the browser coalesces reloads.

## Running the SDK's own server (`aai dev` and host mode)

`createRuntimeServer` (`packages/aai/src/host/server.ts`) is `aai dev`'s
backend and has no request authentication, so both defaults are fail-closed.
This package owns `AAI_DEV_HOST`, `hostModeEnv` and `resolveServerEnv`;
`packages/aai/CLAUDE.md`, "Self-hosted server defaults" has the summary.

- **Binds loopback.** `listen(port, host = DEFAULT_LISTEN_HOST)` is
  `127.0.0.1`; pass `"0.0.0.0"` deliberately. `aai dev` exposes `AAI_DEV_HOST`
  for containers.
- **Host mode is opt-in.** A `?host=1` WebSocket lets the client supply the
  agent definition while spending the operator's credentials, so
  `isHostAllowed` requires `AAI_ALLOW_HOST` of `1`/`true`/`yes`/`on`.
  `resolveServerEnv` surfaces only keys declared in `.env`, so `aai dev` passes
  the shell value through explicitly (`hostModeEnv`).
- **A host client may bring its own provider credentials.** The handshake's
  `credentials` record is merged over the server env for that connection and
  WINS, so a server holding only `AAI_ALLOW_HOST` spends only callers' keys.
  `createHostServer` (`host/host-server.ts`, whose module doc has the
  argument) is that server in one call; `defaults` excludes the four
  handshake-owned fields; `examples/host-server` is the runnable shape.
- **The credential allowlist is a security boundary.** Names are screened
  against `ALL_PROVIDER_ENV_VARS`, checked against the SERVER's env before the
  merge. Unbounded, a client could set `DATABASE_URL` (workflow world, upload
  store, session-state backend on its own Postgres) or `AAI_ALLOW_HOST`.
  Unknown names are REJECTED by name, never silently dropped.
- **A host session with no base agent runs the DEFAULT PIPELINE, not S2S**:
  with no `hostBaseAgent`, one `ASSEMBLYAI_API_KEY` covers STT, LLM gateway and
  TTS. A placeholder `agent()` is not needed.
- **Host-mode audio pacing is the client's declaration and defaults to
  paced** (`HostConfig.audioLeadMs`: omitted = `CLIENT_AUDIO_LEAD_MS`, number
  = that lead, `null` = unpaced). Unpaced lets an S2S reply burst into the
  client's buffer, which a barge-in then discards unheard; paced keeps the
  backlog server-side where `PacedAudioSink.clear()` drops it. tau2 runs at or
  below real time, so it stays paced. Use `null` only for a harness that steps
  faster than real time.

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
  `--skipTypecheck` opts out); the guest's `test_agent` does too. The dev watch
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
  provider credential.** `resolveAgentEnv` (`_dev-server.ts`) falls back to the
  login key only when neither `.env` nor the shell has one. The shell value
  never enters `ctx.env`: it goes through `withHostCredentialFallback`, and
  `agentEnvWarnings` flags it as shell-only.
- **Tests must never resolve the real config dir.** `getConfigDir()` returns a
  per-process temp dir whenever `VITEST` is set (unless `AAI_CONFIG_DIR` says
  otherwise), and `aaiEnv()` sets `AAI_CONFIG_DIR` for spawned CLIs (which run
  with `VITEST` cleared). The guard is in the code path, not a setup file, since
  a config can omit one — and a polluted `approvedServers` (e.g. test loopback
  origins) would let a cloned repo collect the developer's key.
- **`aai build`, `aai dev` and `aai deploy` execute the repo's code locally**
  (`evalWorkerBundle` / `evalWorkerConfig`, and the project's `vite.config.ts`
  since `buildAgentBundle` does not pass `configFile: false` — only the guest's
  untrusted builds do). Running them on an untrusted clone runs that code.
  `aai deploy` imports its bundle for the credential preflight (`_preflight.ts`,
  since the platform stores no agent config — see "The platform stores no agent
  config" in `packages/aai-server/CLAUDE.md`), doubling as a smoke test.

## Self-hosting is the DEFAULT, and `aai build --target` emits per host

**`aai start` is the self-hosting command** (`start.ts`; the module doc has
the precedent). The scaffold's `prestart`/`start` (`aai build --skip-tests`,
then `aai start`) makes every `init`/`pull` project run with `npm start`. The
boot is a command, not a scaffolded file, so improvements reach existing
projects. The custom-server opt-out is `createProjectServer` on
`@alexkroman1/aai-cli/start` — builds the `AgentServer`, binds nothing (also
what a serverless host wants).

**`--target` is Nitro's preset shape** (`_build-target.ts`): an entry file is
EMITTED into build output, never committed. Per-host modules:
`_vercel-target.ts`, `_deno-target.ts`, `_modal-target.ts`; `_target-entry.ts`
(shared long-lived entry), `_target-drain.ts` (signal handler),
`_target-output.ts` (self-contained directory assembly for deno + modal). The
dependency runs one way: `_build-target.ts` reads each host module, never the
reverse — a new target is a new file plus two lines.

- **Detection reads the host's build env**: Vercel via `VERCEL`, `VERCEL_ENV`
  or `NOW_BUILDER` (all three); Deno via `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`
  (both platform generations). It cannot fire for a locally built upload
  (`deno deploy`, `modal deploy`), which passes the flag. Otherwise `node`
  (emits nothing extra).
- **Every target names the command that ships it, as DATA** (`TARGET_OUTPUTS`,
  a total record over `BuildTarget`), printed and on the result (`log` is
  silent under `--json`).
- **A host build WARNS about a declared variable the host has no value for**
  (`missingDeployEnv` in `build.ts`, `missingEnv` on the result,
  `TargetOutput.secret` for the fix command). It reads **the host environment
  only, never `resolveServerEnv`** — `.env` is uploaded into a host's build
  workspace (Vercel ignores `.gitignore`) but not shipped (`RUNTIME_FILES` in
  `_vercel-output.ts`; shipping it would leak credentials). Declarations come
  from `DEPLOY_ENV_DECLARATION_FILE` alone. It warns rather than gates (a build
  cannot see runtime-only host vars); `node` is exempt.
- **Vercel routing brackets `handle: filesystem` with two `/assets/` rules**
  (Vite's content-hashed dir): before it, `cache-control: public,
  max-age=31536000, immutable` with `continue: true`; after it, a terminal 404
  with `no-store` (a miss there is a stale `index.html`, and would otherwise
  inherit the immutable header). Everything else falls through.
- **Vercel's Node major rounds UP** (`vercelNodeRuntime`: smallest offered
  major ≥ the build's, clamped at newest).
- **`--target deno` emits a self-contained `.aai/deno/`** (bundled server,
  worker, client, `.env.example`, no install step — Deno Deploy dies caching the
  CLI's toolchain graph otherwise), plus a `deno.json` with a `start` task
  (`-A`; makes the directory runnable by hand).
- **Long-lived entries drain on `SIGINT`/`SIGTERM`** via one shared
  `TARGET_DRAIN_SOURCE`; registration is wrapped in `try` because a host
  without signals throws from `Deno.addSignalListener`.
- **`_deno-output.scenario.test.ts` checks the module GRAPH** with
  `deno info --json` and reads the modules (not the exit code, which is 0 on
  unresolved deps) — boot-and-serve cannot see a dangling edge in a comment.
  Gated by `describeWithBinary` (`_test-utils.ts`); **`AAI_REQUIRE_DENO`** makes
  the skip a failure (set by CI after `deno --version` answers, declared in
  `check:scenario`'s `env`). Deno is pinned EXACT (2.9.5). Booting the emit is
  `_target-runtimes.scenario.test.ts`'s (below).
- **`--target modal` emits `.aai/modal/` plus a generated `app.py`**
  (`_modal-app.ts`; deploy with `modal deploy .aai/modal/app.py`). Load-bearing
  in it: `@modal.concurrent` (otherwise one WebSocket blocks every other caller
  and asset); `_run_node` forwards the stop signal to node (see `run_node` in
  `scripts/modal_image.py`); `PORT` comes from one constant into both the image
  env and `@modal.web_server(port=…)`.
- **Modal policy is deploy-time env, not edits to `app.py`**:
  `AAI_MODAL_APP`, `AAI_MODAL_SECRET`, `AAI_MODAL_MIN_CONTAINERS`,
  `AAI_MODAL_MAX_CONTAINERS`; `_modal-app.test.ts` checks advertised knobs ==
  read knobs both ways. cpu/memory/timeout/concurrency stay visible constants.
- **Modal has NO auto-detection, deliberately**: `MODAL_IS_REMOTE`/
  `MODAL_TASK_ID` are set inside containers — including this platform's own
  guest sandboxes where studio Publish runs the CLI — and `MODAL_TOKEN_ID` says
  nothing about intent. `_build-target.test.ts` requires every target to be
  selectable by flag.
- **`_modal-output.scenario.test.ts` is the only reader of the generated
  Python**: `python3 -m py_compile`, and an import where the client is
  installed. **`AAI_REQUIRE_MODAL`** makes the skip a failure (a local escape
  hatch — no CI job installs the client). Its boot arm needs no gate: it proves
  no-`node_modules`, `process.env.PORT` and SIGTERM-closes on plain node.

## Self-hosted output must run on Node, Deno and Bun

- **Only the SERVE half is portable** — `createProjectServer` + `listen` + the
  drain over a directory with no `node_modules`. `aai build` is Node; never try
  to certify it elsewhere, and keep anything runtime-specific out of the entry.
- **One entry for every host** (`_target-entry.ts`): `RUNTIME_PORT_SOURCE`
  reads the port under any runtime; `_target-entry.test.ts` pins the real
  entries to one body modulo a banner and a default port.
- **`_target-runtimes.scenario.test.ts` is the certification**: one memoized
  emit, booted under `node`, `deno` and `bun`, each asserting boot without
  `node_modules`, `/health` + `/client-config` + `/`, a `/websocket` dial (to
  `session.configured`, no key spent), and exit 0 on SIGTERM.
- **The bundle's `node:` imports are pinned** to `PORTABLE_NODE_BUILTINS`
  (`_target-bundle.ts`); `FEATURE_DETECTED_NODE_BUILTINS` (`node:sqlite`) must
  never be a static import.
- **Bun floor is 1.4.0** (below it undici crashes on import and a bundled `ws`
  upgrade writes zero bytes). `minVersion` on the bun arm, CI pins 1.4.2, and
  `runtime-pins-gate.test.ts` fails if the pin drops below the floor. A binary
  below the floor counts as absent (skip; failure under `AAI_REQUIRE_BUN`). **Do
  not restore an undici patch for older Bun**; restate the floor. A "works
  outside a bundle, not inside" Bun report: Bun substitutes native `ws` only
  when imported by name.
- **There is deliberately no `--target bun`**: Bun is a runtime, not a host,
  and every target owes a verified non-empty deploy sequence
  (`_build-target.test.ts`).

## Self-hosting is the scaffold's default, and it runs the BUILT worker

**`aai start` imports `.aai/worker.mjs`, which `prestart` (`aai build
--skip-tests`) produces.** Tools are registered by the bundler enumerating
`tools/`, so an un-bundled loader would serve an agent with no tools and no
error. That is why `aai build` leaves its worker on disk and why the scaffold
declares `prestart` (`scaffold/package.json` is the single definition).

- **There is no runtime `tools/` scan anywhere**, by decision — one way to
  build a registry. Specs use `import.meta.glob` (see
  `packages/aai-templates/src/_discovery.ts`).
- **No `registerHooks` shim**: Vite inlines `?raw` and attribute-less `.json`
  imports. The worker import is dynamic via `pathToFileURL` (Windows-correct).
- **A missing artifact exits with the command that fixes it**, never boots a
  tool-less agent or throws a bare `ERR_MODULE_NOT_FOUND`.
- **`ctx.env` and provider credentials come from different places.** `env` is
  declared keys only (`.env`, plus `.env.example` as declarations; real env
  vars win per key), as under `aai dev`. Provider credentials go through
  `withHostCredentialFallback` (so `docker run -e ASSEMBLYAI_API_KEY=…` works
  without entering `ctx.env`). An empty declared value is DROPPED.
- The CLI is a devDependency of self-hosting, so `npm ci --omit=dev` is not
  supported; `prestart` skips only tests.
- `e2e.test.ts` boots `npm start` on an installed `pizza-ordering-agent`
  (chosen for its `tools/`), probes `/health`, `/client-config`, `/`, and reads
  the six tool names out of the booted artifact.

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

### The other fault mode lives in `aai`, and faults a SOCKET

`packages/aai/src/host/_fault-socket.ts` is a TCP proxy that SEVERS live
connections, to test session resume. Choose correctly:

- **This mode kills a PROCESS; that one cuts a CONNECTION.** A restart
  preserves durable slot state (`aai/host/session-state-store.ts`) but not the
  call; a socket drop is the only disconnect a session survives.
- **It severs (`destroy()`), never closes** — a clean close is "user hung up",
  which aai-ui does not reconnect from; `session-resume.scenario.test.ts`
  asserts **1006**.
- **It is a proxy** so no fault injector lives in production code.

## The e2e suite is pnpm-only in CI

`e2e.test.ts` installs an `aai init` project from a mock verdaccio registry.
CI runs pnpm only; `publint` + `attw` cover non-pnpm `exports` resolution.
`AAI_TEST_PM` (`_e2e-test-utils.ts`, declared in `check:e2e`'s `env`) switches
the install for reproducing a user report — a debugging tool, not covered
ground:

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
none. The scenario/integration tiers are Linux-by-design and not worth a
Windows leg.

## Key files

- `cli.ts` — arg parsing, dispatch; `_cli-common.ts` — `defineExec`,
  `sharedArgs`, `setup`, `runCommand`; `_studio-commands.ts` —
  list/pull/push/publish definitions
- `init.ts` / `dev.ts` / `test.ts` / `eval.ts` / `deploy.ts` (internal) /
  `delete.ts` / `secret.ts` — subcommand entry points
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
  (`aai-guest/studio-publish.ts`). Keep it a thin re-export — one writer per
  format.
- `_agent.ts` — agent discovery, dev mode, server URL resolution
- `_utils.ts` (`resolveCwd`, `fileExists`), `_server-common.ts`,
  `_templates.ts`, `_ui.ts` (`log`, `notify`, `fmtUrl`, `parsePort`)
