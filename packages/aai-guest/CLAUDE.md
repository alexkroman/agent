# packages/aai-guest — guest harness guide

The Node entrypoint that runs the complete agent inside each Modal Sandbox
(private package). How the host spawns and supervises it is in
`packages/aai-server/CLAUDE.md`; the studio coding agent that runs in studio
mode is in `packages/aai-studio-server/CLAUDE.md`.

## The harness: one binary, two modes

The Node guest entry point (runs inside a Modal Sandbox) runs the COMPLETE
agent. ONE BINARY, TWO MODES, selected by the spawner via `AAI_GUEST_MODE`
(behavior selection, never a security boundary — capability is what the host
delivers):
  **agent mode** (deployed agents — see "Agent guests are servers") boots
  from files delivered at exec time and serves only the public session
  surfaces — `/websocket` for browsers and `/phone` for carrier media streams,
  both from the SDK's own `createServer` — plus the token-gated
  `/manage/status` + `/manage/drain` pair (`harness-agent-mode.ts`);
  **studio mode** serves
  `/ws` (bearer-token host control channel — JSON-RPC
  `workspace/deploy` (Publish's in-guest `aai deploy`), `status`,
  `studio/session-init`; guest→host
  `studio/sync-workspace`, `studio/persist-chat` — bundle loading and tool
  trials are harness-internal now, driven by the in-guest coding agent,
  not RPC),
  `/session` (PUBLIC client voice sessions, connected directly by
  browsers — the embedded SDK runtime drives STT/LLM/TTS in-guest), and
  `/studio/chat` + `/studio/tools` (the studio coding agent's PUBLIC chat
  surface, bearer-gated by the broker-minted per-session chat token — see
  `packages/aai-studio-server/CLAUDE.md`), plus `POST /studio/session-init`,
  the HTTP twin of the `studio/session-init` RPC gated by the per-sandbox
  HOST token, for the replica that does not hold this guest's single control
  socket (see
  `packages/aai-studio-server/CLAUDE.md`, "One studio sandbox per project,
  fleet-wide").
  `harness.ts` (servers + dispatch), `harness-agent-mode.ts` (agent-server
  boot, manage surface, idle/drain lifecycle), `trial.ts` (run_code
  executor + one-shot tool trials), `harness-rpc.ts` (guest→host request
  proxy), `studio-session-init.ts` (the HTTP install route + the guest's own
  (scope, project) identity pin), `studio-http.ts` (shared CORS + bounded
  body read for both `/studio/*` surfaces),
  `studio-chat.ts`/`studio-tools.ts`/`studio-edit.ts`/`studio-grep.ts`
  (the in-guest coding agent), `studio-build.ts` (in-guest workspace
  builds through the aai CLI bundlers), `studio-publish.ts` (Publish =
  the literal `aai deploy` CLI, run in-sandbox), `limits.ts` (constants —
  import-free except the workspace caps, re-exported from
  `@alexkroman1/aai/workspace-files` so the CLI's push, this sync and
  the platform's validation cannot disagree). The harness embeds NO agent
  runtime — every worker
  bundle ships its own (`__aaiCreateRuntime`, see "User-shipped runtime"
  below) — and tsdown bundles the harness (server shell + studio coding
  agent) into the single `dist/harness.mjs` the server resolves via
  `aai-guest/harness` and bakes into the snapshot image, keeping the build
  toolchain (`@alexkroman1/aai-cli`, the client-build plugins) EXTERNAL:
  it resolves at runtime from the node_modules next to the harness

**Error text comes from the SDK's `errorMessage`, never a local copy.** This
package had three implementations of it at once: a local `errMsg` in
`harness-rpc.ts` used at 33 sites, a hand-inlined ternary in
`studio-session-init.ts`, and — in `harness-crash-guards.ts` — the real
`errorMessage` from `@alexkroman1/aai`, imported under an alias. The local
one was strictly weaker: `errorMessage` also unwraps a non-`Error` object
carrying a string `message`, which is exactly what a thrown value looks like
after crossing this module's own JSON-RPC boundary, and `errMsg` rendered
those as `[object Object]`. One name, one import, and the behaviour is
covered once in `sdk/utils.test.ts`.

**The two files a Publish writes for the CLI come from the CLI'S OWN
writers** (`@alexkroman1/aai-cli/project-config` — `writeConfigHome` and
`updateProjectConfig`). `studio-publish.ts` used to `JSON.stringify` both the
dir-local config home and `.aai/project.json`, so their shapes agreed with the
schemas the CLI parses them back with only by coincidence — and the two
properties that matter are not visible in the JSON at all: the config home
holds the caller's API key and is written **0600 through an atomic rename**
(which TIGHTENS an older world-readable file rather than leaving it), and the
project pin is **merged, never replaced** (`.aai/project.json` also carries the
studio link fields, which a whole-document write drops). Reaching for the
toolchain is safe on this path specifically because `resolveCliEntry()` runs
first and has already failed the publish cleanly if it is not there — so the
dynamic import is deliberately AFTER it. Anything else this package writes for
the CLI to read belongs in that subpath too, not in a `JSON.stringify` here.

## A workspace's own package.json is REIFIED, not just read

`studio-workspace-deps.ts` installs whatever a workspace's `dependencies`
declare that nothing above it already provides, and it runs wherever a
workspace is prepared to be built: `initStudioSession`, `deployWorkspaceDir`
(Publish), and `buildWorkspaceDir` (`test_agent`).

**Declaring a dependency used to be the easy half.** The only thing that ever
put a package on disk was `add_dependency` running in that exact directory, in
that exact session — and a workspace directory survives neither boundary it has
to cross. `materializeWorkspace` opens with `rm -rf`, so a session RE-install (a
page refresh, a replica taking the session over) deletes `node_modules` while
package.json goes on declaring what used to be in it; Publish builds a FRESH
directory from the store snapshot (`withBuildDir`) that never had one at all;
and a project pushed with `aai push` arrives with a manifest whose dependencies
were only ever installed on a laptop. The worker bundle is built
`ssr: { noExternal: true }` — everything is bundled, because the guest that
loads it has no node_modules — so the missing package is not externalized, it is
a hard `Rolldown failed to resolve import "ms"` naming a dependency the manifest
plainly declares. **The agent tested fine and Publish died**, which is the worst
shape that failure could take.

Three decisions, the middle one measured:

- **`dependencies` only.** Those are what `agent.ts` and `client.tsx` import.
  `devDependencies` are the toolchain (vite, typescript, vitest, the
  `@types/*`), baked into the image and resolved by walk-up — a pushed scaffold
  manifest declares all of them, and fetching that set per publish would be a
  large download arriving back where we started. Hence `--omit=dev`.
- **The install goes to the SHARED `.workspaces/` root and names only what is
  missing.** `npm install` reifies the WHOLE manifest it reads — there is no
  flag that adds one package without resolving the rest — and in a workspace
  the rest is the toolchain: installing `ms` there took **25s and 156 MB**, of
  which all but 28 KB was a registry copy of the SDK, React and Tailwind
  already sitting one directory up. Through a manifest naming only `ms`:
  **358ms and 28 KB**. It also retires a hazard rather than managing it: no
  toolchain package is shadowed by a workspace-local copy, which is what
  `reconcileWorkspacePins` otherwise has to keep us on the right side of.
  (`--omit=peer` is there for the same reason — an installed `react` peer would
  hoist into the shared root and shadow the toolchain's for every workspace
  under it, silently changing the React the client bundle is built against.)
  The root is on every workspace's and build dir's resolution path (they are
  created UNDER it) while being outside all of them, so nothing here syncs to
  the store, the `rm -rf` cannot reach it, and a package installed during the
  session is already there when Publish materializes its fresh directory. A
  sandbox serves one project, so the sharing is with itself.
- **One npm run PER PACKAGE, and a failure is un-staged again.** npm resolves a
  manifest as a WHOLE, so anything staged together shares a fate: a bogus name
  beside `ms` and `date-fns` left all three uninstalled (measured against the
  real registry — this is why the first version of this note, which claimed
  narrowing the manifest was enough, was wrong). A run each costs a few hundred
  milliseconds against a warm tree and makes a bad entry cost only itself. The
  un-staging is the half that is easy to miss: left in the shared manifest, one
  unreachable entry is in the file EVERY later install reads, so it would
  permanently break installing anything else in the sandbox rather than failing
  once.
- **A failed install WARNS, it does not throw.** A manifest can name a package
  no source file imports, and failing a publish over one would regress against
  the build that used to succeed by ignoring the manifest entirely. The warning
  is prepended to a FAILING build or publish only (`withDependencyWarning`) —
  it is usually that failure's cause and reads far better than the bundler's
  bare "failed to resolve import", while putting it on a green one would train
  the reader to skip the line.
- **"Satisfied" is not "present", and the difference shipped a wrong bundle.**
  The shared root outlives the build dirs that read it, so a package installed
  for one publish is still sitting there at the next — and an `existsSync`
  therefore answered "already handled" for a workspace that had since CHANGED
  the version it asks for. Measured: pin `date-fns` 3.6.0, publish, bump the
  manifest to 4.1.0, publish again — the second bundle still carried 3.6.0,
  silently. So the shared root only counts when the spec it was STAGED with is
  the spec now declared, which needs no semver matcher because the staged
  manifest is the one npm resolved. The toolchain and the workspace's own
  `node_modules` still answer on presence (the platform owns those versions;
  the workspace's copy is what `add_dependency` reified from this same
  manifest). Consequently npm's **exit code** is the success predicate — on a
  version change the directory is already there carrying the old version, so
  presence proves nothing.

- **The shared root is per PROCESS (`.workspaces/<pid>/`), and that is what
  makes "shared with itself" true.** The argument for one tree is that a
  sandbox serves one project — but the path is a property of the harness FILE,
  and under the subprocess backend every sandbox on the machine execs the same
  `packages/aai-guest/dist/harness.mjs`. Without the pid, N processes serving N
  projects share one staged manifest, and `npm install` PRUNES what that
  manifest no longer declares — so one project's install uninstalls another's
  out from under a build importing it, and `installLock` is in-process so it
  cannot see the other. The session and build dirs carried the pid in their own
  names for exactly this reason; it lives in one place now.
- **The install budget is for the WHOLE reconciliation, not per package**, and
  the lock acquire has a deadline. One npm run per package at `NPM_TIMEOUT_MS`
  meant three unreachable packages could block a caller ~330s; session-init's
  host gives up at 30s (`ADOPT_TIMEOUT_MS`) or 60s
  (`SESSION_INIT_TIMEOUT_MS`) and runs on EVERY page open, so it passes
  `SESSION_INSTALL_BUDGET_MS` (20s) and the rest are reported unattempted
  rather than run past a deadline nobody is waiting on any more. The acquire
  deadline stops a second page open queueing behind an install its own caller
  has already abandoned — which is also why the no-op path must NOT take the
  lock, or a call with no work could fail on contention.
- **A failed spec is remembered for a minute** (`failedInstalls`, keyed
  `name@spec`). Un-staging a failure is required, but it also erases the only
  record that it was tried, so the same doomed npm run re-spawned on every
  `test_agent` — the loop the coding agent runs while repairing a build. The
  key includes the spec so an edited version retries at once, and the TTL is
  short so a registry blip is not cached for the sandbox's life.
- **Hoisted packages that shadow the toolchain are logged.** `--omit=peer`
  closes one instance of the mechanism; an ordinary transitive dependency uses
  the same one, so a user package depending on `react` lands it in the shared
  root ABOVE the toolchain and the client bundle silently builds against a
  registry copy. `warnOnShadowedToolchain` checks the mechanism — top-level
  entries that also exist in the toolchain — which is what makes the
  "no shadowing" claim above checkable rather than asserted. It logs rather
  than warning through `describeMissing`, because a shadowed package does not
  FAIL the build (that is the problem with it) and the chat-facing channel only
  surfaces on failure.

**A missing dependency's first symptom is TS2307, and it has a hint**
(`studio-diagnostics.ts`). `Cannot find module 'date-fns'` fires at the
typecheck gate before the bundler says anything, and the hint names
`add_dependency` — because installing is only half of what that tool does, and
the half that matters here is RECORDING the package in package.json, which is
what makes it survive a refresh and a Publish.

**Lockfiles do not sync** (`snapshotWorkspace` passes `isLockfile`). This is
the guest's one departure from its own walk, and it is not cosmetic:
`add_dependency` runs `npm install`, which reifies the whole manifest, so the
`package-lock.json` it leaves measured **92 KB after one dependency and 101 KB
after three** — the overwhelming bulk of every turn's sync payload, ~40% of the
256 KB per-file cap, a file `read_file` can spend context on, and, since `aai
pull` materializes whatever the row holds, an npm lockfile landing in a project
whose package.json declares pnpm. `walkWorkspace` still shows it, because that
one backs `list_files`/`grep`; only the SYNC has a reason to drop it. Push's
other local-only rule, `.env`, deliberately does NOT apply here — the coding
agent may have written that file itself.

**Known cost, unfixed: `add_dependency` is the slow half of this.** It runs
`npm install <spec>` in the WORKSPACE, which reifies the whole manifest —
measured **28s and 202 MB across 150 packages** to add `date-fns`, nearly all
of it a redundant registry copy of the SDK, React, Tailwind and every provider
SDK already baked one directory up (and a workspace-local copy of the SDK that
shadows the baked one, safe only while `reconcileWorkspacePins` keeps the pins
exact). The same package through the shared root costs **358ms and 28 KB**.
Rerouting the tool through `ensureWorkspaceDependencies` would collapse that
and leave ONE place custom dependencies live; the reason it has not been done
is `--omit=peer`, which is right for a reconciliation pass over an existing
manifest and wrong for a package a human just asked for — a peer the toolchain
does not carry would silently not be installed. Settle that before rerouting.

Specs that name a LOCATION rather than a version (`file:../x`, `git+ssh://…`,
`github:owner/repo`, `npm:alias@1`) are refused by name: they resolve relative
to the directory npm reads them from, and this reads them from the shared root
rather than the workspace that wrote them, so carrying one across would quietly
mean something else. `add_dependency` is unchanged and still installs into the
workspace — this module only fills in what a manifest declares and nothing has
installed.

## The `run_code` executor (`trial.ts`)

- Executes **only inside the guest sandbox** (Modal/Node): the harness wires
  its in-sandbox executor into the runtime as `RuntimeOptions.runCode`
  (`run_code` is in `SANDBOX_ONLY_BUILTINS`). The old host-side `node:vm`
  execution was removed — `node:vm` is not a security boundary; the Modal
  container is.
- The host-side `execute` (`builtin-run-code.ts`) is a guard for the
  self-hosted path (`aai dev`), which has no sandbox — it refuses rather
  than evaluating attacker-influenceable code in the host process.
- The executor is a bare `new Function` async wrapper: code runs with the
  **same authority as the rest of the sandboxed agent** — open egress,
  filesystem, env, child processes — and nothing more. There is deliberately
  no in-process capability stripping; the container is the whole boundary.
  (This is why the tool description promises only "output from console.log",
  not "no network/filesystem" — that claim would be false now.)
- 5-second execution timeout (enforced in the guest).

## Dev/prod parity

**The guest IS the dev server — and the runtime IS the user's.** The
harness wraps the same `createServer` (`aai/host/server.ts`) that `aai dev`
runs — health, `client-config`, and `/websocket` sessions — adding (per
mode) the `/manage/*` request hook or the `/ws` control channel, plus a
lazy runtime facade (`lazyRuntime` in `aai-guest/harness.ts`: the runtime
is built on the first session — a `test_agent` load carries an empty env).
The runtime itself comes from the BUNDLE (see "User-shipped runtime"
below), so dev and prod run the identical SDK version: the one in the
user's lockfile. In agent mode the bundle arrives at exec time — a file or
a signed URL, hash-verified either way (`harness-bundle-source.ts`); the
studio's test_agent loads its build in-guest through the same loader.
There is **no deploy-time inspection mode**: the platform stores no agent
config and never asks a bundle to describe itself (see "The platform stores
no agent config" in `packages/aai-server/CLAUDE.md`). Either way it
loads from a temp-file `file:` URL.

## User-shipped runtime

The worker bundle ships its own SDK runtime. `buildWorker`'s generated
wrapper entry exports `__aaiCreateRuntime` — a factory over the *user's
installed* SDK's `createRuntime`, bundled in with the provider SDKs (an SSR
Vite build: server resolve conditions, `node:` builtins external, dynamic
imports inlined via `codeSplitting: false`) — and the harness builds every
session through it. The harness embeds no runtime at all, so **platform SDK
drift can never break a deployed agent**: it runs exactly the runtime
version it was built and tested against, the same one `aai dev` ran.

- The harness↔bundle contract is deliberately tiny (`CreateGuestRuntime` in
  `aai-guest/harness-types.ts`): `{ env, db?, runCode? }` in,
  `{ startSession, shutdown }` out. Keep it that way — everything else
  (provider resolution, tool dispatch, session state) is the bundle's SDK's
  business, on the bundle's SDK's version.
- A bundle without the factory is rejected at load ("rebuild with a
  current @alexkroman1/aai-cli"); there is no embedded-runtime fallback.
- Deploy artifacts are therefore ~8 MB minified before user code
  (`MAX_WORKER_SIZE` is 30 MB), and `evalWorkerBundle` imports workers via
  a temp `file:` URL — the bundled runtime's CJS interop calls
  `createRequire(import.meta.url)`, which rejects `data:` URLs.
- The dev server passes `runtime: false` to `buildWorker`: it builds its
  runtime in-process from the same installed SDK anyway, and inlining the
  runtime on every watch rebuild would make reloads multi-second.
  `aai build` / `aai deploy` / studio builds always ship it.

**Known remaining asymmetries**, none closable without larger work:

| Divergence | Direction | Why it stands |
| --- | --- | --- |
| Modal memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) | works in dev, fails in prod | `aai dev` runs tools in the host process with no caps; a memory-hungry tool OOMs only when deployed. |
| `run_code` | fails in dev, works in prod | The host-side guard refuses rather than evaluating in-process. Fail-closed, so harmless. |
| `withHostCredentialFallback` (`providers/host-env.ts`) | works in dev, fails in prod | Deliberate ergonomic: an exported `ANTHROPIC_API_KEY` should work for `aai dev`. Two guards keep the cliff visible: the dev server warns when a required key resolved from the shell only (`agentEnvWarnings` in `_dev-server.ts` — it won't survive `aai deploy`, which uploads `.env`), and `aai deploy` preflights required credentials against the env it is about to upload (`aai-cli/_preflight.ts`), so the gap surfaces as a deploy-time warning naming the key rather than as an auth error at first session. It WARNS rather than rejects — the CLI cannot see secrets already stored server-side. |
| `ctx.db` backing (BYO `DATABASE_URL` in dev vs platform-provisioned schema+role) | prod is stricter | Dev connects wherever the developer points it; prod pins search_path + statement_timeout on a per-app role. |
| Platform sandboxes need Modal credentials in production only | prod is stricter | `aai dev` runs tools in-process; the platform spawns real Modal sandboxes in production (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`), and an isolation-free child process in local dev — see `packages/aai-server/CLAUDE.md`, "Modal sandbox notes". |

## Agent guests are servers (no control channel)

DEPLOYED AGENTS spawn as servers (`spawnAgentServer` in sandbox-vm.ts;
guest side in `aai-guest/harness-agent-mode.ts`). The whole
platform↔deployed-agent contract, frozen per deploy by the harness image
pin and versioned by `GUEST_CONTRACT_VERSION` (additive changes only):

- **Boot**: the spawner writes the agent env as a FILE into the fresh sandbox
  (`sb.filesystem.writeText` on Modal, a scratch dir on the subprocess
  backend), then execs the harness with `AAI_GUEST_MODE=agent` + the artifact
  locations + the bundle's sha-256. The BUNDLE arrives one of two ways and the
  spawner picks by naming one env var or the other — `AAI_BUNDLE_PATH` for a
  file written the same way, or **`AAI_BUNDLE_URL` for a time-boxed signed
  Storage URL the guest fetches itself**, which is production's path and keeps
  ~8 MB from crossing the platform twice per cold spawn (see
  `packages/aai-server/CLAUDE.md`, "The guest fetches its own bundle"). The
  guest hash-verifies the bundle either way against `AAI_BUNDLE_SHA256` — the
  agents row's own record of what the deploy published — so it trusts the HASH
  and never the transport, and a mismatch is a hard boot failure rather than a
  silently different agent. It then loads the bundle BEFORE listening, and
  scrubs the env file. The two shapes are mutually exclusive on the wire on
  purpose: there is no precedence rule for either side to get wrong, and no way
  to point a guest at a path nobody wrote.

  Readiness is the guest's public `/health` answering 200 —
  polled by the host, raced against guest-process exit so a boot crash
  fails the spawn immediately with the guest's stderr in the host log
  (relayed from the moment the process exists — see `startGuestLogging`;
  draining only once the guest was READY discarded exactly the output that
  explains a boot failure).

  **How long a guest may take to boot and how long a CLIENT waits for it are
  separate budgets.** They were one number, so an agent whose top-level code
  blocks — never ready — hung every broker call for the full
  `AGENT_HEALTH_TIMEOUT_MS` (120s) before its 503, permanently. The broker
  caps its own wait at `BROKER_READY_TIMEOUT_MS` (20s, env overridable; 0
  waits for the whole boot budget) and answers 503 while the boot CONTINUES:
  the sandbox is already attached to its slot and reports `alive()` while
  pending, so the next call joins the SAME readiness promise instead of
  spawning a second sandbox. Tripping it on a healthy-but-slow boot costs one
  client reconnect, not a failure — `session-core.ts` re-brokers per attempt
  and only an ANSWERED lookup latches anything.
- **Ongoing surface**: `GET /manage/status` (live session count +
  draining + contractVersion — an operator/debugging probe; nothing
  host-side gates on it anymore) and
  `POST /manage/drain` (`?deadlineMs=` carries the retire budget the guest
  enforces itself), both gated by the per-sandbox bearer
  from the exec env. Nothing else — no WebSocket, no RPC, no host
  connection. The guest's public `/client-config` doubles as the broker's
  name/greeting source (proxied — see `packages/aai/CLAUDE.md`,
  "Pre-connection client config").
- **Lifecycle is guest-owned — the host runs NO idle machinery**: the agent
  guest self-exits after `AGENT_IDLE_EXIT_MS` (5 min; override by setting
  `AAI_GUEST_IDLE_EXIT_MS` on the SERVER, which `agentBootEnv` forwards into
  the guest's exec env — a guest reads only what it is handed at exec, so
  setting it on the platform process is what reaches BOTH backends) with
  zero sessions —
  this IS idle reclamation, not a backstop (the host's per-slot idle timers
  were deleted); the exit surfaces host-side as `onSandboxLost`, which
  detaches the slot, and the next broker call rebuilds it. A drained guest
  refuses new direct-dial sessions (close 1013 → the client re-brokers) and
  exits the moment it empties or at its drain deadline.
- **Redeploys hand over BLUE-GREEN** (`handoverSlot` in
  sandbox-resolve.ts): the agents-row change event boots the NEW deploy's
  sandbox and waits for its readiness before detaching the old one, so a
  redeploy never leaves an empty slot — the next caller lands warm while
  the old sandbox drains its calls in the background. A replacement that
  fails to boot retires the old resident anyway (an empty slot keeps the
  failure visible on the next broker call; silently serving superseded
  code would not).

## The snapshot image

Where the harness this package builds actually RUNS from in production. The
host side — `modal-harness-image.ts`, the content-addressed tag, per-deploy
pinning on `agents.harness_image_tag` — lives in
`packages/aai-server/CLAUDE.md`; what follows is the artifact itself, which is
this package's.

- **The harness AND the build toolchain are baked into a snapshot image**,
  not written per spawn, in two halves that cache differently. The
  TOOLCHAIN is a native image LAYER (`toolchainImage`: a
  `dockerfileCommands` `RUN npm install` into `/opt/aai/node_modules` — the
  aai CLI bundlers plus the workspace-facing packages), so Modal's own
  layer cache serves it and a harness rebuild — every
  server code change — no longer reinstalls ~15 packages. The HARNESS needs a
  throwaway builder sandbox, because the JS SDK's `dockerfileCommands` takes
  commands with no build context and there is nothing to `COPY` a ~13 MB local
  bundle from: a sandbox started from the layer writes it, its filesystem is
  snapshotted (`snapshotFilesystem`), and the image is `publish`ed under a
  content-addressed tag
  (`aai-guest-harness:<hash(base image, harness, toolchain)>`), so every
  later spawn — and every other replica, across restarts — resolves it with
  one `images.fromName` call. A new harness build, base-image change, or
  toolchain bump mints a new tag. This is the only harness-delivery path; a
  failed build fails the spawn loudly (memo cleared, next spawn retries).
  DEPLOYED AGENTS spawn from the tag recorded on their agents row at deploy
  time (`harness_image_tag` — per-deploy pinning, so a platform upgrade
  never changes the environment under an already-deployed bundle). An
  unresolvable pin FAILS the spawn loudly — silently substituting the
  current image is exactly the untested-environment drift pinning exists to
  prevent; the operator kill switch `SANDBOX_IGNORE_IMAGE_PINS=1` forces
  the current image for every spawn when a registry loss makes that trade
  explicitly. Studio sandboxes always run the current image.
- **The harness's V8 COMPILE CACHE is baked into the same snapshot.** The
  harness is one ~13 MB bundle and every sandbox boots it cold, so V8 paid the
  same parse+compile on every spawn. The builder sandbox now runs the harness
  once in **warm-up mode** (`AAI_GUEST_WARMUP=1` — evaluates the module, opens
  nothing, exits 0) under `NODE_COMPILE_CACHE`, before `snapshotFilesystem()`,
  and `guestExecBaseEnv()` points every guest exec at the resulting
  `/opt/aai/.compile-cache`. Measured on the real bundle: **~570ms → ~345ms**,
  i.e. ~200ms off every cold voice session and studio broker call, for
  ~1.5 MB in the image. Three things make it safe: a
  missing or stale entry is a silent MISS (the cache keys on Node version +
  file content, so a bumped base image simply misses), the warm-up is
  best-effort (a failure logs and still publishes — the cache is an
  optimization, and failing the build would take all spawning down for a
  perf tweak), and it is Modal-only, since the cache is a property of the
  baked image and the subprocess backend has no image.

  **Warm-up is a DECLARED mode, and both halves are tested, because the
  failure is invisible.** A warm-up that stops compiling the harness leaves a
  cache that is merely empty: the image builds, every guest boots, and the
  200ms comes back forever with nothing reporting it. It relied on the
  `AAI_GUEST_TOKEN` check to exit for us at first — true by accident, and it
  would silently rot the moment that check moved. So the mode is checked
  before every other mode in `main()`, and `modal-harness-image.test.ts`
  pins BOTH sides: the host asks for the warm-up before snapshotting (fake
  Modal), and the real built harness honours it with no token (real spawn).
  Note the fake sandbox had no `exec` at all when this landed, so the
  host-side assertion had to be added with it — without `exec` the warm-up
  threw into its own best-effort catch and every test stayed green.

- **The guest toolchain is LOCKED, and the lock is committed**
  (`packages/aai-guest/toolchain/{package.json,package-lock.json}`, regenerated
  by `pnpm sync:guest-toolchain`, gated by `pnpm check:guest-toolchain` in
  `scripts/check.sh` AND the CI check job). Without it the resolved tree is a
  function of WHEN the layer was built, while the published tag and Modal's
  layer cache both key on the install command's TEXT — so one
  `harness_image_tag` could mean two different trees, the exact opposite of
  the per-deploy environment pinning the tag exists for. The install is
  therefore two steps, and the split is forced:
  - **Third-party packages: `npm ci` against the committed lockfile.** Their
    versions and integrity hashes are known at commit time, and this is where
    nearly all the transitive surface lives (vite/rolldown, typescript,
    vitest, react, tailwind). `npm ci` also refuses to run when the manifest
    and lockfile disagree, so a hand-edited manifest fails the BUILD.
  - **`@alexkroman1/*`: `npm install` at exact resolved versions.** These
    CANNOT be locked here — their versions change every release, and a
    lockfile entry needs an integrity hash that only exists once the version
    is PUBLISHED, which happens after the commit that bumps it. Their own
    dependencies (the provider SDKs) therefore still resolve at install time;
    closing that residual gap needs a post-publish regeneration step, not a
    lockfile in this repo.

  Both files are written by the RUN itself, gzipped and base64'd (~20 KB), for
  the same reason the harness cannot be `COPY`'d: `dockerfileCommands` carries
  no build context. The image TAG hashes the lockfile's content, not the
  manifest's — the manifest names direct versions, the lockfile names the whole
  tree, so a purely transitive change still mints a new tag.
  Only the Modal backend needs this: the subprocess backend's harness runs
  from `packages/aai-guest/dist/` and resolves the toolchain through
  aai-guest's own `node_modules` — the same walk-up shape as `/opt/aai`, with
  nothing to build or mount. The `workspace-build-integration.test.ts` suite
  keeps the path covered on any runner by spawning the harness there directly
  and publishing through the real CLI to a real listening orchestrator.

## Fetching its own bundle

The guest pulls its own worker bundle from a signed Storage URL rather than
having the platform write the bytes into the sandbox. The host-side plumbing
is in `packages/aai-server/CLAUDE.md`; the boot contract is here, because
agent mode is what enforces it.

A cold agent spawn used to move the worker bundle — ~8 MB typical, 30 MB cap —
through the PLATFORM REPLICA **twice**: `loadBundleParts` read the blob out of
Supabase Storage into the replica's heap, and `spawnModalAgentServer` wrote
those same bytes into the sandbox with `filesystem.writeText`. Neither hop
bought anything. The guest now fetches the bundle itself from a time-boxed signed
Storage URL (`BlobStorage.signedUrl` → `BundleStore.getWorkerUrl` →
`WorkerSource` in `sandbox-vm.ts` → `AAI_BUNDLE_URL` in the exec env), and both
transfers disappear.

**The hash is the whole security argument, and it predates this.** Agent mode
already refused to load a bundle whose sha-256 did not match `AAI_BUNDLE_SHA256`
(`readAgentBoot`), so the guest trusts the HASH, never the transport. What
changed is where that hash comes from: the agents row's `worker_hash` — the
deploy's own record of what it published — rather than a digest of the bytes
the host happened to be holding, which made the check a tautology on the file
path. The URL grants read of exactly one immutable blob, carries no
service-role key, and expires (`WORKER_URL_TTL_SECONDS`, 5 min — sized against
the 120s readiness budget plus scheduling, because a URL expiring inside it
turns slow Modal scheduling into a boot failure that only appears under
capacity pressure).

**There is no fallback for a failure.** Signing throws and fails the spawn,
like every other spawn failure; the client re-brokers. `signedUrl` resolving
`null` means something else entirely — *this backend cannot sign* — which is
true only of the memory blob store behind local dev and tests, and puts them on
the byte path. Conflating the two would silently put production back on the
byte path with nothing reporting it.

**A pinned guest may be too old to understand it, and that is checked**
(`guestUnderstandsBundleUrl`). Deployed agents spawn from the harness image
pinned on their row, so the guest can be arbitrarily older than the platform,
and a `GUEST_CONTRACT_VERSION` 1 harness reads only `AAI_BUNDLE_PATH` — handed
a URL it fails boot outright. Nothing can ask a guest its version *before*
exec, so the host compares images instead: no pin, or `SANDBOX_IGNORE_IMAGE_PINS`
(which must agree with `resolveSpawnImage` substituting the current image), or a
pin equal to the tag the SERVER process builds. The tag hashes the harness
content, so "same tag" means "same harness". **So the saving lands per
deploy**, as agents are redeployed onto a harness that understands the URL —
not all at once when this ships.

One side effect worth knowing: `loadBundleParts` now reads the agents row ONCE
and derives the worker source from it, where it previously issued `getAgent`
and `getWorkerCode` concurrently and each read the row.
