---
summary: >-
  The guest harness: one binary / two modes (plus warm-up), user-shipped runtime, dev-prod
  parity, `run_code`, guest network access + SSRF, credential separation, and
  the snapshot image the harness runs from
read_when: >-
  changing what runs inside a sandbox, what a guest may reach, or how the guest
  image and its toolchain are built
---

# packages/aai-guest — guest harness guide

The Node entrypoint that runs the complete agent inside each sandbox (private).
Host-side spawning and supervision: `packages/aai-server/CLAUDE.md`. The studio
coding agent that studio mode runs: `packages/aai-guest-studio/CLAUDE.md`; the
shared guest modules (`rpc`, `types`, `bundle`, `auth`, `http`, `trial`,
`limits`): `packages/aai-guest-core/CLAUDE.md`.

## Directory guides

- `src/harness/CLAUDE.md` — agent mode: boot contract, bundle fetch + hash
  check, `/manage/*` and its derived token, guest-owned idle/drain lifecycle,
  the log ring, the `AAI_DEBUG` forward, `/phone`.
- [`CODING-AGENT-TESTS-CLAUDE.md`](CODING-AGENT-TESTS-CLAUDE.md) (reference
  sibling) — testing and evaluating the studio coding agent.

## Layout

- `src/harness.ts` — tsdown's one entry (`entry: ["src/harness.ts"]`): servers,
  mode dispatch, `lazyRuntime`. Stays beside `src/harness/`, not in it.
- `src/harness/` — the modes' modules (agent mode, manage, logs, bundle
  source, crash guards, leak watch, externals test).
- `toolchain/` — the locked guest toolchain manifest + lockfile. It is part of
  the guest image's Docker build context: **never put a guide or anything
  non-shipping in it.**
- `sdk-tarballs/` — build-context slot for packed workspace SDK tarballs
  (`.gitkeep` committed; see "And the SDK in a LOCAL image…").
- `dist/harness.mjs` — the single bundled artifact `aai-server` resolves via
  `aai-guest/harness` and bakes into the image.

## The harness: one binary, two modes

`AAI_GUEST_MODE`, set by the spawner, selects the mode (a third, warm-up, exists
only for the image build — see "The snapshot image") — **behaviour selection,
never a security boundary**; capability is whatever the host delivers.

- **Agent mode** (deployed agents): boots from files delivered at exec time and
  serves only `/websocket` and `/phone` (the SDK's `createRuntimeServer`) plus
  token-gated `/manage/*`. See `src/harness/CLAUDE.md`.
- **Studio mode**: `/ws` (bearer-gated host control channel — JSON-RPC
  `workspace/deploy`, `status`, `studio/session-init`; guest→host
  `studio/sync-workspace`, `studio/persist-chat`), `/session` (public browser
  voice sessions), `/studio/chat` + `/studio/tools` (public, gated by the
  broker-minted per-session chat token), and `POST /studio/session-init` (HTTP
  twin of the RPC, gated by the per-sandbox HOST token, for replicas without the
  control socket — "One studio sandbox per project, fleet-wide" in
  `packages/aai-studio-server/src/CLAUDE.md`).

The harness embeds NO agent runtime (see "User-shipped runtime"). tsdown
bundles the server shell and the studio agent into `dist/harness.mjs`, keeping
the build toolchain (`@alexkroman1/aai-cli`, client-build plugins) EXTERNAL —
resolved at runtime from the `node_modules` beside the harness.

**Error text comes from the SDK's `errorMessage`, never a local copy** — it
unwraps a non-`Error` object with a string `message`, which is what a value
looks like after crossing the JSON-RPC boundary.

## Dev/prod parity

**The guest IS the dev server, and the runtime IS the user's.** The harness
wraps the same `createRuntimeServer` `aai dev` runs, adding per mode the
`/manage/*` hook or `/ws`, plus `lazyRuntime` (built on first session — a
`test_agent` load carries an empty env). In agent mode the bundle arrives at
exec time, hash-verified (`harness/bundle-source.ts`); `test_agent` loads
through the same loader. **No deploy-time inspection mode**: the platform stores
no agent config ("The platform stores no agent config" in
`packages/aai-server/CLAUDE.md`).

Known remaining asymmetries:

| Divergence | Direction | Why it stands |
| --- | --- | --- |
| Memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) | works in dev, fails in prod | `aai dev` runs tools uncapped in the host process. |
| `run_code` | fails in dev, works in prod | The host-side guard refuses; fail-closed. |
| `withHostCredentialFallback` (`providers/host-env.ts`) | works in dev, fails in prod | Deliberate: a shell-exported key works for `aai dev`. The dev server warns when a required key came only from the shell (`agentEnvWarnings`), and `aai deploy` preflights required credentials (`aai-cli/_preflight.ts`) — warns, since it cannot see stored secrets. |
| Durable-run backing | different backend | Dev uses the DevKit postgres world at the developer's `DATABASE_URL`; a deployed guest reaches run storage, queue, session state and uploads over HTTP and opens no tenant DB connection. |
| Modal credentials | prod stricter | Production spawns Modal sandboxes (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`); local dev uses an isolation-free child process ("Modal sandbox notes", `packages/aai-server/MODAL-CLAUDE.md`). |

The guest base image's Node major is covered under "The snapshot image".

## User-shipped runtime

The worker bundle ships its own SDK runtime: `buildWorker`'s wrapper exports
`__aaiCreateRuntime` over the user's installed SDK, and the harness builds every
session through it. **Never import `createRuntime` in the harness** —
konsistent `guest-embeds-no-runtime`; platform SDK drift must never break a
deployed agent.

- **The contract stays tiny** (`CreateGuestRuntime`,
  `aai-guest-core/types.ts`): `{ env, runCode?, publicUrl? }` in,
  `{ startSession, shutdown }` out. Membership rule: **a capability or fact only
  the HARNESS holds** (`runCode` = the sandbox executor; `publicUrl` = the
  spawner's `AAI_PUBLIC_BASE_URL`, translated by `ensureRuntime` so the SDK never
  reads an `AAI_*` key). Every field is OPTIONAL and additive: old bundles
  ignore new fields, new bundles degrade without them.
- A bundle without the factory is rejected at load; no embedded fallback.
- Bundles are ~8 MB before user code (`MAX_WORKER_SIZE` 30 MB).
  `evalWorkerBundle` imports via a temp `file:` URL (the runtime's CJS interop
  calls `createRequire(import.meta.url)`, which rejects `data:`), and **unlinks
  the file once `import()` resolves** — otherwise repeated `test_agent` runs fill
  `tmpdir()`.
- The dev server passes `runtime: false` to `buildWorker` (fast reloads);
  `aai build` / `aai deploy` / studio builds always ship it.

## The `run_code` executor (`trial.ts`)

Lives in `aai-guest-core`; the harness wires it as `RuntimeOptions.runCode`
(`run_code` is in `SANDBOX_ONLY_BUILTINS`).

- **Executes only inside the guest sandbox.** The host-side `execute`
  (`builtin-run-code.ts`) refuses under `aai dev` rather than evaluating
  attacker-influenceable code in the host. `node:vm` is not a boundary; the
  container is.
- A `new Function` async wrapper **in a worker thread**, with the same authority
  as the rest of the sandboxed agent (egress, fs, env, child processes) and no
  in-process capability stripping. The tool description promises only
  "output from console.log" — never claim "no network/filesystem".
- **5s timeout enforced by `worker.terminate()`, never a promise race** — code
  with no `await` never yields, and in-process it wedged the whole guest
  (`/health`, every session, the idle timer). Each call gets a fresh isolate and
  its own `process.env` copy; leftover timers die with the worker.
- **The worker body is a string constant** (the harness is one file,
  `codeSplitting: false`). The model's code travels as `workerData`, never
  spliced into that source.

## Guest network access

**No per-agent egress policy.** Agent code runs with open egress, as under
`aai dev`. The Modal container is the isolation boundary: a tenant can reach the
internet, not the platform.

**Network builtins screen only when there is no container around them**
(`builtinFetch` in `aai/host/ssrf.ts`):

- **Contained** (Modal) → plain `pinnedFetch`. A screen there constrains only
  the model, not an author with open egress; the container holds no platform
  credentials (a `DATABASE_URL` is the author's own).
- **Not contained** (`aai dev`, subprocess backend) → `safeFetch`: the host is
  someone's machine, and a model-controlled URL could reach localhost, the LAN
  or cloud metadata.

**Containment is DECLARED by the spawner, never inferred**: `modal/sandbox.ts`
sets `AAI_SANDBOX_CONTAINED=1`; the subprocess backend does not. "Am I a guest"
≠ "am I contained" — a guest-token sniff would open egress on a laptop.
`ssrf.test.ts` pins it. Accepted residual risk: prompt injection steering the
model at an internal endpoint inside a container with nothing internal.

**SSRF screen rules (`aai/host/ssrf.ts`):**

- One implementation in the SDK, shared by the platform's guest-fetch proxy and
  the SDK's builtins.
- `resolveAndAssertPublic()` uses `bogon`; handles IPv4-mapped IPv6
  (`::ffff:127.0.0.1`); blocks `.internal`, `.local`, cloud-metadata hostnames
  and non-HTTP(S).
- Re-validates every redirect hop; strips credential headers once a redirect
  leaves the origin.
- **Pins the IP via an undici dispatcher `lookup`, never by rewriting the URL
  hostname** (breaks SNI/cert verification). Keep the URL intact.
- **Dispatcher and `fetch` must come from the same undici**: `safeFetch` routes
  through `pinnedFetch` (undici's own fetch); **never reintroduce
  `globalThis.fetch`** (Node's bundled undici is a different major, and the
  mismatch kills all guarded egress as `fetch failed`). Callers may not name a
  fetch implementation (`fetchFn` is test-only), and guard tests cover the call
  site. Guarded by `ssrf-dispatcher.test.ts`.
- **Never hand a `FormData`, `Blob`, `File`, `Headers` or `Request` to a `fetch`
  that may not be your realm's** — undici brand-checks with its own classes
  (a `FormData` goes out as `text/plain` `[object FormData]`). Pass bytes.
- `web_search`, `visit_webpage`, `get_page_design`, `fetch_json` take
  model-controlled URLs and **default** to `safeFetch` (`builtin-tools.ts`).
  Not opt-in; only tests override `fetch`.

## Credential separation, and what reaches a guest

Each agent supplies its own `ASSEMBLYAI_API_KEY` (`.env` locally, `aai secret
put` in production); there is no platform-owned key. `SandboxOptions` separates
`apiKey` (host-only, for S2S) from `agentEnv` (forwarded to the guest); the key
is extracted at sandbox creation and kept host-side.

- **A guest inherits nothing from the host process** — only what the spawner
  writes into its boot env (see the `AAI_DEBUG` forward in
  `src/harness/CLAUDE.md`).
- **A database is the AUTHOR's; the platform provisions none.** A `DATABASE_URL`
  in the agent env is an author secret delivered like any other — no overlay, no
  platform-composed value — matching `aai dev`'s `.env`. Durable state (session
  slots, event log, workflow runs) is the PLATFORM's, reached over HTTP with the
  sandbox's own bearer (`packages/aai-server/CLAUDE.md`).
- **Agent secrets** live in Supabase Vault (`agent-env:<slug>`).
- **Credential resolution reads the agent env only — never `process.env`.** The
  host holds its own credentials under names a tenant descriptor could resolve
  (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`). **Both** helpers stay sealed:
  `resolveApiKey` (`providers/resolve.ts`, descriptor-declared keys) and
  `requireApiKey` (`providers/_utils.ts`, every STT/TTS opener and LLM).
- Self-hosted runs opt into shell keys via `withHostCredentialFallback`
  (`providers/host-env.ts`, copies only `PROVIDER_CREDENTIAL_ENVS`) into
  `RuntimeOptions.providerEnv`, **never `env`** — credentials must not reach
  `ctx.env`. Type-enforced by the branded `HostCredentialEnv`
  (`sdk/env-types.ts`, locked by `env-types.test-d.ts`).
- **Children running workspace-authored code get an allow-listed env**
  (`workspaceChildEnv()`; stricter `cliChildEnv()` for the deploy child) — no
  control-channel bearer leaks to user code by inheritance. Details:
  `packages/aai-guest-studio/CLAUDE.md`.

**Cross-agent isolation:** no shared tenant database exists; the platform's own
DB is unreachable from a guest (durable-state routes are HTTP, per-sandbox
bearer, scoped by the caller's slug server-side). Each sandbox has its own
authenticated channel, sessions are per-sandbox, and no mutable state is shared
between sandboxes.

## A `neverBundle` package must be INSTALLED beside the harness

Every `neverBundle` entry in `tsdown.config.ts` becomes a runtime resolution
against the `node_modules` beside the harness (`/opt/aai` baked, this package's
own in dev), so it must be (1) external in the ARTIFACT and (2) installed there
— via the locked toolchain (`LOCKED_PACKAGES` in
`scripts/sync-guest-toolchain.mjs`) or `modal/harness-image.ts`'s
`@alexkroman1/*` install. `harness/externals.test.ts` pins both on the real
artifact (`aai-guest#test` declares its own `build`).

**Ask of any new dependency whether it reads its own directory.** A package
reading data files beside itself cannot be bundled
(`@workflow/world-postgres`'s Drizzle `meta/_journal.json` → `neverBundle`). One
reading only its own `package.json` is better PATCHED than externalized:
`@workflow/world-local` is statically imported by `@workflow/core`, so
externalizing it costs every spawn; `patches/@workflow__world-local@4.2.4.patch`
returns the version from a constant, and `externals.test.ts` asserts the
`"bundled"` sentinel is absent.

## The snapshot image

The artifact is this package's; the host side (`modal/harness-image.ts`, the
content-addressed tag, `agents.harness_image_tag`) is `aai-server`'s
("MODAL-CLAUDE.md").

- **Harness and toolchain are baked into a snapshot image**, never written per
  spawn. The TOOLCHAIN is a native layer (`toolchainImage`: `RUN npm install`
  into `/opt/aai/node_modules`), cached by Modal. The HARNESS needs a builder
  sandbox (`dockerfileCommands` has no build context): it writes the bundle,
  `snapshotFilesystem()`, and publishes as
  `aai-guest-harness:<hash(base image, harness, toolchain)>`. A failed build
  fails the spawn loudly (memo cleared).
- **Deployed agents spawn from the tag pinned on their row**; an unresolvable
  pin FAILS the spawn (never substitute the current image).
  `SANDBOX_IGNORE_IMAGE_PINS=1` is the explicit operator override. Studio
  sandboxes always run the current image.
- **The V8 compile cache is baked in**: the builder runs the harness in
  **warm-up mode** (`AAI_GUEST_WARMUP=1` — evaluate, open nothing, exit 0) under
  `NODE_COMPILE_CACHE`, and `guestExecBaseEnv()` points guests at
  `/opt/aai/.compile-cache` (~200ms off every cold boot). Stale entries are a
  silent miss; the warm-up is best-effort; Modal-only. **Warm-up is checked
  before every other mode in `main()`**, and `modal/harness-image.test.ts` pins
  both sides (host asks for it; real harness honours it with no token) — a
  broken warm-up is otherwise invisible.
- **The toolchain is LOCKED** (`toolchain/{package.json,package-lock.json}`,
  `pnpm sync:guest-toolchain`, gated by `pnpm check:guest-toolchain`), because
  the tag keys on the install command's text. Two steps, forced:
  third-party packages via **`npm ci`** against the lockfile; `@alexkroman1/*`
  via **`npm install` at exact versions** (unlockable — their integrity hashes
  exist only after publish).
- **Neither step runs install scripts** (`--ignore-scripts`) — the unlocked step
  has no integrity hash or release-age quarantine. Safe because the
  script-carrying packages (`esbuild`, `@swc/core`, `cbor-extract`) ship
  prebuilt binaries. `toolchain-install-scripts.test.ts` fails when the lockfile
  gains an unvouched install-script package. The flags are not in the tag
  fingerprint.
- Manifest + lockfile are written by the RUN itself (gzip+base64, no build
  context); the tag hashes the LOCKFILE, so transitive changes mint a new tag.
- The subprocess backend runs `dist/harness.mjs` and resolves the toolchain from
  this package's `node_modules`; `workspace-build-integration.test.ts` covers
  that path.

**Node major.** Base image defaults to `node:26-slim` (pin via
`MODAL_SANDBOX_IMAGE`; `MODAL_APP_NAME` selects the Modal App, default
`aai-server`). It must track the SERVICE image (`scripts/modal_image.py`),
`.node-version` and `@types/node` — a split means production and `aai dev` run
different runtimes. **Known split: `.node-version` says 24 against
`node:26-slim`.** Every package declares `engines.node >=24`, so **code may use
only APIs on Node 24** — `tsc` cannot enforce it (`lib: ["ESNext"]`), so
`Map.prototype.getOrInsert*`, `Iterator.concat`, `Temporal` typecheck and then
throw on the floor (`runtime-tools.ts` is the worked example). Safe:
`crypto.hash()`, `module.enableCompileCache()`, `await using` +
`Symbol.asyncDispose`. `DisposableStack`/`AsyncDisposableStack` are unverified
(note in `studio-session-broker.ts`).

## The image has an OCI recipe, and production pulls it

`packages/aai-server/guest-image.Dockerfile` builds the same image as a plain
OCI image (`pnpm build:guest-image`), so the local backend and Modal can pull
one reference; a build context makes the harness and toolchain plain `COPY`s.

- **`GUEST_IMAGE_REGISTRY` is the switch**: set → Modal spawns resolve
  `<registry>/aai-guest-harness:<sha16>` via `images.fromRegistry`; unset (the
  code default) → the server builds its own snapshot. **Production sets it** (in
  the Modal secret). Policy: `aai-server/guest-image-source.ts`
  (`resolvePinAcrossSources` handles pins missing from the registry).
- **The TAG is identical across sources** (the registry source only prepends a
  registry), so recorded pins survive the switch; tested.
- **A missing image fails at CREATE, not resolution** (`fromRegistry` is lazy),
  so the chosen source and registry are logged at boot.
- **Published by a RELEASE, live on a DEPLOY.** `ship.yml`'s image job `needs:
  release` (no `paths` filter: the tag hashes nearly all of `packages/`); a new
  tag goes live only when a version-bump deploy ships a server hashing to it.
  Between releases main's head has no published image — for local dev leave
  `GUEST_IMAGE_REGISTRY` unset, push with `scripts/build-guest-image.mjs`, or
  dispatch `ship.yml`.
- **The Dockerfile lives in `aai-server`** beside the constants it mirrors
  (`GUEST_SYSTEM_PACKAGES`, `SDK_PACKAGES`, `GUEST_ROOT`,
  `DEFAULT_SANDBOX_IMAGE`) so `guest/image-dockerfile.test.ts` is hashed with
  them; the build CONTEXT is this package (`toolchain/`, `dist/harness.mjs`).
- `scripts/build-guest-image.mjs` READS ARG values from that TypeScript; each
  extractor throws on a mismatch. Base image and guest root are committed copies
  (test fails on drift); `SYSTEM_PACKAGES` and `SDK_SPECS` have no default and a
  `test -n` guard.

## A harness edit needs the IMAGE rebuilt

The microVM backend boots `aai-guest-harness:local`, with the harness BAKED in:
**`pnpm build:guest-image --msb` makes a harness edit live**, not
`ensure-guest-harness.mjs` (which rebuilds `dist/harness.mjs` for the
subprocess backend and test tiers only). Symptom: a guest ignoring a change that
a fresh `dist/harness.mjs` demonstrably contains. Same trap on Modal.

## And the SDK in a LOCAL image is this checkout's, not npm's

A guest's agent bundle resolves `@alexkroman1/*` from the IMAGE's
`node_modules`, so `SDK_SPECS` in `guest-image.Dockerfile` decides which SDK:

| Build | `SDK_SPECS` | Installs |
| --- | --- | --- |
| local (`pnpm build:guest-image [--msb]`) | paths under `sdk-tarballs/` | this checkout, packed |
| `--sdk-pack-dir <dir>` (CI release) | paths under `sdk-tarballs/` | the release's `changeset pack` tarballs |
| `--registry` / `--push` (CI otherwise) | `name@version` | published versions |
| local `--published-sdk` | `name@version` | published versions |

- `packWorkspaceSdk` builds and `pnpm pack`s the four packages (`workspace:*`
  becomes exact versions).
- **A registry/push build may never install unpublished code** — a recorded pin
  must resolve forever. No flag opts a pushed image into the workspace SDK.
- **`--sdk-pack-dir`** takes npm off the release path; `stageSdkPackDir` fatally
  asserts the plan version equals the checkout's and each tarball matches the
  publish plan's sha256.
- The TAG hashes `resolveSdkSpecs()` (declared versions), never tarball paths.
- **Local defaults to this checkout** because `:local` promises "whatever this
  checkout is", and a version string cannot tell a released tree from a dirty
  one.
- The tarball `COPY` sits after `npm ci` (cache), and `sdk-tarballs/.gitkeep`
  is committed so the COPY never fails; `guest/image-dockerfile.test.ts` pins
  both.

## ffmpeg is installed, and a step reaches it through the SDK

`GUEST_SYSTEM_PACKAGES` (`aai-server/modal-system-packages.ts`) installs
`ffmpeg` (+`ffprobe`) via apt — never an npm binary (`ffmpeg-static` is GPL-3.0
and counts against a published package's size budget). Steps use
`@alexkroman1/aai/ffmpeg`; its runner, dev fallback (`AAI_FFMPEG_PATH`) and the
`AAI_REQUIRE_FFMPEG=1` scenario gate are the SDK's (`host/ffmpeg.ts`, whose doc
lists the runner's four properties; worked
example `packages/aai-templates/FFMPEG-CLAUDE.md`). The package list is in the
image fingerprint (`toolchainFingerprint`), its layer FIRST; every added package
ships in every guest image.

## Building the harness for a test run

`scripts/ensure-guest-harness.mjs` is the aai-server vitest `globalSetup` (the
only config declaring it): it builds `aai-guest` when `dist/harness.mjs` is
missing or older than this package's or `packages/aai`'s sources.
`GUEST_HARNESS_PATH` skips it.

**Inside a turbo task (`TURBO_HASH`) it VERIFIES and throws, never builds** — a
turbo cache hit restores an old mtime, so the heuristic misfires, and a nested
build races sibling tasks reading `dist/`. **A harness a turbo task needs must
be DECLARED** (`^build` or `aai-guest#build`). It also runs as `predev` in
aai-studio-server and `predeploy:modal` in aai-server.

## Testing this package

- `src/_test-utils.ts` holds `stubProcessExit`; the shared guest helpers
  (`useTempDir`, `installFakeHostChannel`, `runTool`, `materialize`) are
  `aai-guest-core/test-utils` (see that guide).
- **A test's tier is what it touches** (root `AGENTS.md`): a file that writes
  to disk, binds a port or spawns a subprocess is `*.scenario.test.ts`, which
  `vitest.config.ts` excludes from the unit run. Split a file on what it touches
  rather than lowering a coverage floor.
