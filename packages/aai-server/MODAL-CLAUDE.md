# packages/aai-server — images and sandbox backends

A SIBLING of `packages/aai-server/CLAUDE.md`, not a second package guide.
Claude Code auto-loads only `CLAUDE.md`, so nothing here is resident: read it
when you touch `scripts/modal_image.py`, `modal_deploy.py`, or
`microsandbox-*.ts`. It exists because the platform guide hit the 120,000-char
agent-context cap (`pnpm check:claude-md`, which measures this file too — the
pathspec is `*CLAUDE.md`) and this is the one subject in it that is REFERENCE
for a build recipe rather than behaviour on a request path.

`konsistent.json`'s `workspace-package-layout` requires a `CLAUDE.md` per
package and forbids no other file, so a sibling is permitted; the root guide's
"points at every package guide" assertion
(`packages/aai-gates/src/claude-md-limit.test.ts`) globs `packages/*/CLAUDE.md`
exactly and does not reach this name.

Everything else about the platform — the sandbox lifecycle, the three backends'
SELECTION policy, the security model — is in `CLAUDE.md` beside this file.

## The image is layered dependencies-first (`scripts/modal_image.py`)

The service image installs, then builds, and the two halves have deliberately
different cache keys:

1. **Install inputs only** — the lockfile, `pnpm-workspace.yaml`, `.npmrc`,
   every workspace manifest, and every patch file `patchedDependencies` names,
   staged into a temp dir by `_stage_install_inputs`.
2. `pnpm install --frozen-lockfile`.
3. **The source tree** (`add_local_dir(REPO_ROOT, …)`), which merges into the
   installed `/app` rather than replacing it — `BUILD_IGNORE` keeps
   `node_modules` out of the copy. `ASSERT_INSTALL_SURVIVED` runs before the
   build so that assumption fails as one sentence at image build, not as a
   missing module twelve steps later.
4. `BUILD_COMMAND`.

It used to be one `add_local_dir` for the whole repo followed by install and
build in a single step, so **any** file change — a test, a doc — invalidated
the install and refetched the entire dependency tree. The win is not deploy
latency (`modal deploy` builds before any traffic moves, and under Modal's
rolling strategy the old containers serve throughout); it is the **cold
start**, where a container on a worker that already holds the install layer
pulls only what changed.

**Everything in the recipe must be IMPORTABLE without the repo present, and
that is not a style rule — it is the difference between a deploy and a
crash-loop.** Modal re-imports the deploy script inside every container to
hydrate the function, so `build_image` runs a second time where the repo does
not exist and `REPO_ROOT` (derived from `__file__`, mounted at `/root/`)
resolves to `/`. Modal's own `Image` builder calls are LAZY, so naming
`REPO_ROOT` in one is fine; computing an argument to one by reading the
filesystem is not. `_stage_install_inputs` did, and the container died at
import with `FileNotFoundError: '/pnpm-lock.yaml'` — it is guarded on
`modal.is_local()` now, returning an empty staging dir off-host.

**Every signal a deploy has is blind to that failure**, which is why it ran for
hours: `modal deploy` exits 0, the image builds, CI goes green, the app reads
`deployed`, and — because the rolling strategy keeps the PREVIOUS deploy's
containers serving — the health endpoint answers 200 and the request log stays
clean. What actually shipped was a service that could not scale out or replace
a container, one container-death away from an outage with no recovery path.
Observed 2026-08-09: 13 failed container starts over four minutes, production
served for the next two hours by a container that predated the deploy, and the
only trace was a `Function modal_deploy.server is crash-looping` line in an app
log nobody was reading. Hence two guards, at different distances:
`modal-image-inputs.test.ts` pins the `is_local` short-circuit statically (a
gate that fails in the ordinary test run), and **`ship.yml`'s verify step**
(`scripts/verify_modal_deploy.py`) asserts after every deploy that a container
started AFTER the deploy began and that the service answers — the general net,
since it catches any startup failure rather than this one. Checking health
alone would not have caught it; the stale container was answering fine.

**The manifests are NORMALIZED, and without that the split would be pure
ceremony.** A layer's cache key is the bytes that go into it, and a
package.json's `version` moves on every changeset release — which is exactly
and only when a deploy happens (`ship.yml` fires on a version bump). Copied
verbatim, the install layer would therefore miss on every production deploy.
`INSTALL_MANIFEST_FIELDS` is a whitelist of the fields install actually reads;
`version` and `scripts` are dropped, so the layer survives a release and
misses only on a real dependency change. The full manifests still land in the
source layer, so the built image carries each package's true version.

**A `patchedDependencies` entry names a FILE, and that file is an install
input** — the yaml is copied byte-for-byte, so a declared patch not staged
beside it fails the layer with `ENOENT: … open '/app/patches/<name>.patch'`
while pnpm hashes it against the lockfile. Every other signal is green, the
patch being in the tree. `_patch_paths` carries why it derives the paths and
raises on a declaration it cannot read; `modal-image-inputs.test.ts` pins it.

**The image also bakes the SERVER's V8 compile cache**, the same trick the
guest snapshot bakes for the harness. After `BUILD_COMMAND`, a build step runs
the built entry once in warm-up mode (`AAI_SERVER_WARMUP=1`, honored at the top
of `aai-studio-server/index.ts` — it evaluates the module graph and exits 0,
opening no port, socket, or database connection) under `NODE_COMPILE_CACHE`,
and the resulting `/app/.compile-cache` ships in the layer; `.env()` points the
container's node at the same directory, which is the half that is silent when
it drifts — a warmed cache nothing consults costs exactly what no cache costs.
Measured on the built bundle: **~600ms → ~395ms**, i.e. ~200ms off every cold
start, for ~3.6 MB in the image. Unlike the harness's warm-up this one is
deliberately FATAL to the build: it runs the real entry, so a non-zero exit
means the artifact production is about to run cannot be evaluated at all.
`modal-image-inputs.test.ts` pins the three things that must agree (entry path,
flag name, cache directory) across the recipe and the entry.

Dropping `version` is safe **because every workspace dependency here is
`workspace:*`**, which matches any version. A `workspace:^` anywhere would
silently break that, so `modal-image-inputs.test.ts` asserts it — along with
the two other ways this drifts: a workspace glob added to
`pnpm-workspace.yaml` but not to `WORKSPACE_MANIFEST_GLOBS`, and a manifest
that grows a dependency-declaring field (`overrides`, `resolutions`,
`optionalDependencies`) the whitelist does not carry. The first fails loudly
at image build as a lockfile mismatch; the second does **not** — the install
succeeds and merely resolves a different tree than the source layer expects,
which is why it needs a test rather than a comment.

## The local backend is a microVM

`microsandbox-sandbox.ts` boots the guest in a libkrun microVM from the SAME OCI
image production pulls: the studio agent's `bash`/`run_code` stop running as the
server's uid, and in-guest builds resolve production's `/opt/aai` toolchain
rather than aai-guest's darwin `node_modules`. Boot WARNS when the image is
missing, rather than letting the first session eat a 30s dial timeout:

`pnpm build:guest-image --msb` builds the image and loads it into
microsandbox's own store — **and a harness edit is not live until it has run**
("A harness edit needs the IMAGE rebuilt", `packages/aai-guest/CLAUDE.md`).
`pnpm --filter aai-server test:scenario` runs the real-microVM tier. Four traps,
all measured:

- **`.network()` REPLACES the network config**, so a `.port()` called before it
  is discarded — silently. The harness logs `listening on 0.0.0.0:8080` inside
  the guest while every host dial gets ECONNREFUSED, which reads as a guest that
  failed to boot. The published port therefore goes INSIDE `.network()`.
- **A guest's `127.0.0.1` is the VM.** `microsandbox-network.ts` rewrites the
  agent env to a host alias and opens exactly the ports that rewrite needed — a
  policy opening the `host` GROUP would pass every "can it reach the database"
  test while handing tenant code the whole machine.
- **`isInstalled()` lies** (false where microVMs boot fine), so the scenario gate
  asks the runtime a real question. That tier SKIPS without hardware
  virtualization — GitHub's standard runners do not reliably provide it — and
  `AAI_REQUIRE_MICROSANDBOX=1` makes the skip a failure where they do.
- **A name is NOT released when the sandbox dies** — Modal's property, which
  `sandbox-directory.ts` rests on and microsandbox does not share. A SIGKILLed
  VM left its slug permanently unreachable; `createReclaimingName`'s doc has it.

## No warm pool — every spawn boots from the snapshot image

There is NO warm sandbox pool (`sandbox-pool.ts` and its `SANDBOX_POOL_SIZE`,
`pool` role and `setTags` plumbing are deleted — production always ran with it
disabled, so it was pure complexity). Every spawn — agent, studio — boots
directly from the published content-addressed harness snapshot image, one code
path per backend, and every sandbox knows its identity (role/slug tags) at
creation. When Modal's
JS SDK exposes sandbox MEMORY snapshots (today it exposes only
`snapshotFilesystem`; memory snapshots are Python-SDK experimental),
restore-from-snapshot slots into this single spawn path — do NOT
reintroduce a host-managed pool to approximate it.

## Sandboxes are unpinned; the WEB service PREFERS the database's region

**Both placement sites take the SAME list.** `modal_deploy.py` passes
`region=REGIONS` to the web function AND exports it as `MODAL_SANDBOX_REGION`
into the shared image (`",".join(REGIONS)`), which `modal-sandbox-env.ts`
parses into Modal's `regions` create param for every guest spawn. It is
DERIVED rather than written twice, because a second literal is one nothing
compares: the host would keep preferring `us-east-2` while guests drifted, on
a green deploy whose only symptom is latency. An operator can still override
the variable per environment; empty or absent is unpinned, which is local dev.

**It is a LIST at both sites, and that is the load-bearing half.**
`["us-east-2", "us-east"]`. Read the two halves
separately, because they answer to different failures: the PREFERENCE is
earned by a measurement, and the FALLBACK is what keeps the outage below
unreachable.

What earned it is that the Supabase round trips stopped being outside a
latency budget. A durable run journals per operation and the engine's calls
are sequential by construction — `claimAttempt` before a step's body,
`appendStep` after it — so a run's wall clock is a multiple of this
container's distance from the database. Measured on a deployed
`use-transcript-workflow`, one 300 KB / 4-second recording, one clean walk:
**14 × `POST /:slug/workflow-journal` at ~460-666 ms of server time each,
~7.3 s, to move 2.3 KiB of JSON.** The same 14 calls over the same route and
statements against a local Postgres: **31.4 ms**. So ~99% was distance, and
none of it the statements, the pool, the bearer check or the payload. The
`aai` project is `us-east-2`, and everything under the broad `us-east` is tens
of milliseconds from it, so a spill still lands two orders of magnitude better
than an unpinned placement.

**The fallback is a BROAD region rather than a second datacenter, and that was
Modal's call.** The spill was first written as `us-east-1`, and the deploy
refused it:

```text
Regions us-east-1 are not supported. See
https://modal.com/docs/guide/region-selection for supported regions
```

Note the shape of that failure: it is a DEPLOY error, not a placement one, so
`modal deploy` exits non-zero, the app keeps serving the previous revision, and
the release ships nothing — a change looks merged and is not running. Which
specific regions a workspace may name is Modal's to decide and nothing in this
tree can derive it, so `REGIONS` is held to strings a real deploy has accepted
(`modal-image-inputs.test.ts`), and adding an entry means having deployed it.
Reaching for a granularity level instead of a datacenter is also what Modal's
own guide recommends: a wider pool is what improves availability, which is the
same property the fallback exists for.

A single-value pin is a different thing and stays forbidden. The WEB
service's earlier bare `us-east-2` took production down, and it is worth
knowing the shape because no symptom names
a region: the app sits at `deployed` with **zero tasks** despite
`MIN_CONTAINERS=1`, requests hang until the client times out having received
**zero bytes**, and there are **no container logs at all** — not a crash,
because no container is ever created, so `modal app logs` replays the last
image build and then streams silence. Everything that normally localizes a
fault says healthy: the image builds, the secrets resolve, and booting the
entry by hand inside the function's own spec (`modal shell <file>::server
-c 'node …'`) serves fine. Neither a redeploy nor `modal app rollover`
helps — both only re-ask for a container that still cannot be placed. A
warm floor is what makes a pin dangerous, which is why the answer was a
fallback ORDER rather than either a bare region or no preference at all: a
second entry makes "placed nothing" unreachable while still expressing where
this container wants to be. `modal-image-inputs.test.ts` pins the list's
length, its first entry (against the database's region — a first entry that
drifts keeps the risk and deletes the benefit), that every entry is one a
deploy has accepted, and that the decorator really reads it; each is A/B'd
against the corresponding regression.

**The guest pin was removed once, and what it was removed for was the SINGLE
region.** Exporting a bare `MODAL_SANDBOX_REGION=us-east-2` confined every
guest to one region's spare capacity, and the failure that buys is a spawn
Modal cannot schedule inside the ~50s `sandbox.tunnels()` waits, surfacing as
`SandboxTimeoutError: Sandbox operation timed out` — the whole session fails,
and the more regions are available the less often it happens. That is this
section's zero-container outage one layer down, so it takes the same remedy
rather than the opposite one: a spill entry, not no preference.

The locality argument moved too. It was "AGENT guests have no host channel at
all, so a voice turn crosses that hop **zero** times, and only the studio's
control-channel RPCs pay it, outside any latency budget" — still true about
voice, and it is not what decides this any more. A DURABLE RUN's journal calls
are made by the GUEST, one platform round trip each, sequential by
construction: **~24 ms an operation out of region against ~2 ms in it**, and a
walk makes a dozen or more. So the guest→platform hop is inside a latency
budget now in exactly the way the platform→Supabase hop is, and the thing that
stops it being an availability risk is the fallback entry.

## Guest resources are a BURST RANGE

**Reserve the idle shape, cap the build shape.** `SANDBOX_MEMORY_MB` /
`SANDBOX_CPU` reserve; `SANDBOX_MEMORY_LIMIT_MB`
/ `SANDBOX_CPU_LIMIT` cap. Modal constrains the pair from both sides — a bare
cap fails sandbox creation ("must also specify cpu when cpuLimit is
specified") and a reservation above its cap is rejected — so
`parseSandboxLimitsFromEnv` reconciles them in one place and **throws on a
cap with no reservation**, naming the env var, rather than letting the spawn
die inside Modal on parameters the operator never set.

**Why they must stay two numbers is argued in `modal_deploy.py`'s own
guest-sandbox resources block** — the bimodal load, the direct-reclaim wedge
a single number produced, and why the cgroup cap defeats moving the bundler
into a child process (#845, reverted in #863). Read it there; this guide is
the copy at a size cap. What it does not carry is the MEASUREMENT, so: on a
wedged production sandbox, RSS pinned flat at 1.29 GB, ~1 core split seven
ways across 4 V8 GC workers + the main thread + 2 rolldown workers, **zero**
I/O, 453 CPU-seconds and no progress, versus 253 MB / 0.97 CPU-seconds on an
idle sibling. It reads as a hung build, never as an OOM — and
`--max-old-space-size` cannot help, because the memory is native rather than
V8's.

**The burst range is set in ONE place** — the guest-sandbox resources block
in `aai-server/modal_deploy.py`, the only Modal app there is. Studio
sandboxes (coding-agent sessions, Publish) are spawned by that same process
and inherit it, which matters because their `test_agent`/Publish builds are
the workload the cap exists for. (This said "BOTH Modal apps … keep the two
blocks in lockstep" until the second one went with the split deployment.)

## The guest snapshot image is resolved AT BOOT, not on the first spawn

`prewarmModal(harnessPath)` in modal-context.ts, called from
`assertSandboxBackendOrWarn`. Two memoized stages otherwise charged to
whoever spawns first: the Modal app lookup (a gRPC round trip), and the
harness image — reading the ~13 MB harness, the synchronous SHA-256 that
forms its content-addressed tag, and resolving that tag. On a harness
version nobody has published yet — i.e. right after EVERY deploy —
"resolving" means BUILDING: toolchain layer, builder sandbox, 13 MB write,
`snapshotFilesystem`, publish. That landed on one unlucky user's first
voice session or studio chat. `createGuestSandbox` awaits the same memoized
promise, so a spawn racing the prewarm joins it rather than starting a
second build, and replicas racing each other are no worse than the
concurrent cold spawns that raced before (the resolver tries
`images.fromName(tag)` first). Fire-and-forget: a failure only warns and
the memo resets, exactly as when the first spawn was the first caller.

## A `skopeo` manifest miss is reported as nothing at all

**Modal reports it as `Image build for im-<id> failed with the exception:` and
then NOTHING** — no tag, no registry, no remedy. One outage per image path so
far, and the two paths failed differently. PINNED: the TAG is
source-independent, the IMAGE is not (each source publishes one place
only), so setting
`GUEST_IMAGE_REGISTRY` orphaned every earlier `harness_image_tag`;
`resolvePinAcrossSources` probes Modal first and logs the ref. CURRENT — a
studio session, a first-ever spawn — logged nothing, that promise having been
kept on the pinned half alone, and its create escaped
`SandboxUnavailableError`, both spawners calling `createGuestSandbox` OUTSIDE
the terminating `try`: a 500 where the taxonomy owes a 503. See
`translateSpawnFailure`, and `guest-image-wait-gate.test.ts` for the gate that
no-op'd over a broken publisher for three green deploys.

## Rolling back: `modal app rollback` first, a dispatch second

`ship.yml`'s header calls `workflow_dispatch` "the escape hatch for shipping,
or rolling back to, a commit that is not a release", and as a *rollback* that
is the slow half of the answer: it re-checks out, re-packs the SDK, rebuilds
the guest image, rebuilds the service image and re-runs `migrate` — the whole
~20 minutes, during which production is still serving the bad version.

Modal has a direct lever, and it should be step one of an incident:

```sh
modal app rollback aai-server-web                      # to the previous version
modal app history aai-server-web                       # list versions + tags
modal app rollback aai-server-web --strategy recreate  # terminate first, don't drain
```

Four things to know before reaching for it:

- **It is a new deployment, not a time machine.** The version number
  increments and the rollback is attributed to whoever triggered it; what
  resets is the App's functions and metadata, independently of the current
  codebase. So the tree and production disagree afterwards, and the durable
  fix is still a dispatch (or a forward release).
- **`--strategy` matters here.** The default `rolling` keeps old containers
  serving until the restored ones pass their cold start, which is what you
  want for a bad-but-serving version. `recreate` terminates first and queues
  inputs, which is what you want when the current version is actively
  corrupting something.
- **It does NOT roll back the schema.** `migrate` ran before the deploy and
  DDL does not reverse, so a rollback lands old code on the new schema. That
  is exactly what the expand/contract rule in `supabase/README.md` exists to
  make survivable — read it before assuming a rollback is safe, and if the
  release contained a contraction, a rollback is NOT safe and a forward fix
  is the only option.
- **Aim it by tag.** `ship.yml` passes `modal deploy --tag "$DEPLOY_TAG"` with
  the commit it built, so `modal app history` names a SHA per version rather
  than a bare number. Without that tag the dashboard could not tell you which
  version to roll back to, which is the whole reason the flag is there.

## Modal sandbox notes

- **Three backends, selected by `sandbox-backend.ts`.** Guest sandboxes are
  **remote Modal Sandboxes** (`modal-sandbox.ts`) in production, a **local
  microVM** (`microsandbox-sandbox.ts`) in local dev, and a plain **child
  process** (`subprocess-sandbox.ts`) only when named. The policy is three
  rules: an explicit `SANDBOX_BACKEND` always wins (unknown values throw — a
  silent fallback would look like the override not working); otherwise
  not-local-dev → `modal`, unconditionally; otherwise → `microsandbox`.
  `isLocalDev` is an explicit **`AAI_LOCAL_DEV=1`** and nothing
  else, so `modal` is the DEFAULT and **production can never resolve the
  host-local backend** — it fails loudly without
  `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (or a `~/.modal.toml` profile) rather
  than degrading. There is **no fallback between backends at spawn time**: a
  failed spawn is a failed spawn.

  That sentinel was `!SUPABASE_STORAGE_BUCKET`, which inverted the rule it
  exists for — see "Two questions, two sentinels" above, which owns the account.
- **Every spawn failure is a `SandboxUnavailableError`** (`sandbox-errors.ts`)
  — both Modal spawners, both subprocess spawners. It is a marker class, not a
  message: the message stays the backend's technical one (`Modal sandbox spawn
  failed: Sandbox operation timed out`), and `createErrorHandler` turns the
  class into a **retryable 503** carrying one authored sentence
  (`SANDBOX_UNAVAILABLE_MESSAGE`), logged at `warn` with the full `cause`
  chain. Keeping the two apart is what lets the log stay specific while the
  wire body leaks nothing.

  The agent path always had this taxonomy — `brokerSessionUrl` answers 503 for
  any spawn failure — but the STUDIO path had none, so a Modal capacity
  timeout reached the shared handler as a bare `Error`: logged
  `Unhandled error on /studio/projects/<x>/session`, answered
  `500 Internal server error`. Both halves were wrong. The platform was not
  broken, and the studio client (which retries 5xx) left the user staring at
  "Internal server error" once its retries ran out, with no way to tell
  "try again in a minute" from "this project is broken". `SandboxNameTakenError`
  is deliberately NOT one of these — it is a routing signal the broker
  catches, never an answer to a client.
- **There IS a middle tier now, and the three objections it had to answer are
  in `sandbox-backend.ts`'s module doc** — including the one that INVERTED (one
  image recipe, so no second toolchain delivery mechanism). A stale
  `SANDBOX_BACKEND=apple-container` still throws at boot.
- **`subprocess` is opt-in now, not the local default.** It has **no isolation
  at all** — tenant agent code and the studio agent's `bash`/`run_code` run with
  the server's uid, filesystem and network — and boot says so unconditionally
  (`assertSandboxBackendOrWarn`). It keeps the *shape* that catches integration
  bugs and has no prerequisites, which is why it stays; `subprocess-sandbox.ts`
  carries what it does and does not reproduce. The shared harness lifecycle
  (exit fan-out, memoized cleanup, dial retry, stdio draining, port allocation)
  lives in `warm-harness.ts` and is used by all three backends.
- The guest base image defaults to `node:26-slim`; pin via
  `MODAL_SANDBOX_IMAGE` for reproducible guests. `MODAL_APP_NAME` selects the
  Modal App sandboxes are created under (default `aai-server`). **Its major
  tracks the SERVICE image's and `.node-version`, and that split floor decides
  which Node 26 features may be used where — a rule `tsc` cannot enforce.** See
  "The guest image's Node major, and the split floor it creates" in
  `packages/aai-guest/CLAUDE.md`.
- **Modal reports a `skopeo` manifest miss as `Image build for im-<id> failed
  with the exception:` and then NOTHING** — no tag, no registry, no remedy — one
  outage per image path so far, and the PINNED and CURRENT paths each failed a
  different way. `resolvePinAcrossSources` probes Modal first and logs the ref;
  a create escaping `SandboxUnavailableError` is a 500 where the taxonomy owes a
  503 (see `translateSpawnFailure`). Both accounts, and the gate that no-op'd
  over a broken publisher for three green deploys, are in
  [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md).
- **The harness, the build toolchain, and the V8 compile cache are baked into
  a snapshot image**, not written per spawn — with the toolchain LOCKED by a
  committed lockfile so one `harness_image_tag` can only ever mean one tree.
  That artifact is the guest's, so its construction, its two cache layers, and
  the split install (`npm ci` for third-party, `npm install` for
  `@alexkroman1/*`) are documented where it is owned: see "The snapshot image"
  in `packages/aai-guest/CLAUDE.md`. The host half — `modal-harness-image.ts`,
  the content-addressed tag, and per-deploy pinning via `harness_image_tag` —
  stays here.
- Sandboxes are created with open egress and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h).
- **Guest resources are a BURST RANGE: reserve the idle shape, cap the build
  shape.** `SANDBOX_MEMORY_MB` / `SANDBOX_CPU` reserve;
  `SANDBOX_MEMORY_LIMIT_MB` / `SANDBOX_CPU_LIMIT` cap. Modal constrains the
  pair from both sides, so `parseSandboxLimitsFromEnv` reconciles them in one
  place and **throws on a cap with no reservation**, naming the env var, rather
  than letting the spawn die inside Modal on parameters the operator never set.
  The range is set in ONE place — the guest-sandbox resources block in
  `aai-server/modal_deploy.py` — and studio sandboxes inherit it. Why they must
  stay two numbers, plus the measurement off a wedged production sandbox (RSS
  flat at 1.29 GB, 453 CPU-seconds, zero I/O, no progress — it reads as a hung
  build, never an OOM), is in [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md).
- **Every sandbox is tagged with a `role`** (`sandbox-role.ts`: `agent`,
  `preview`, `studio`, `studio-publish`) plus the `slug`
  (studio sandboxes carry the project name), so the Modal dashboard can tell
  a production voice agent from a preview deploy or a studio coding-agent
  session. Every spawn knows its identity at creation. Observability only: nothing
  may gate on these tags, and the `preview` role is inferred from the
  `-preview` slug suffix (`PREVIEW_SLUG_SUFFIX`, defined once in the SDK's
  slug contract — `aai/sdk/slug.ts`, reachable as `@alexkroman1/aai/utils` —
  because three independent things key off it and a disagreement is silent
  data loss: the deploy boundary rejects the suffix, the reaper deletes
  agents carrying it, and the CLI refuses to derive a project name ending in
  it. It lives in the SDK rather than aai-server because the CLI needs it and
  cannot import a private package).
- **The `-preview` opt-in is DECLARED by the caller, never inferred from the
  slug.** `deployAgentBundle` rejects a requested `*-preview` slug unless
  `allowPreviewSlug` is set, and only the studio's auto-preview deployer sets
  it — it targets `<project>-preview` on purpose. Publish shares the very same
  in-guest `aai deploy` invocation and must leave it unset. It used to ride on
  that shared invocation unconditionally, reasoned as "harmless for a
  production Publish, whose slug has no such suffix" — true only for
  server-minted project names. A CLI push derives the project name from the
  DIRECTORY, so a directory named `demo-preview` published straight through
  the guard and got an agent the hourly sweep would delete. Inferring the
  opt-in from the slug's shape would NOT have fixed it: a production Publish
  of such a project passes exactly that slug.
- **The guest snapshot image is resolved AT BOOT, not on the first spawn**
  (`prewarmModal(harnessPath)` in modal-context.ts) — otherwise the Modal app
  lookup and the harness image resolve, or right after every deploy BUILD, on
  one unlucky user's first voice session or studio chat. A spawn racing the
  prewarm joins the same memoized promise. Details in
  [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md).
- **Readiness is Modal's readiness PROBE**, not host-side polling
  (`GUEST_READINESS_PROBE` in modal-context.ts): every guest sandbox is
  created with `readinessProbe: Probe.withTcp(8080)` and the spawn awaits
  `sandbox.waitUntilReady()`. A TCP probe is exactly equivalent to the
  `/health` 200 it replaced, and that equivalence is a property of the
  harness's boot order rather than a guess: agent mode reads its boot files,
  hash-verifies and LOADS the bundle, and only then calls `server.listen` — so
  the port opening means "sessions can be served". A harness that listened
  first would report ready before it could serve anything. The wait is always
  raced against guest-process EXIT (`raceGuestExit` in warm-harness.ts): every
  boot failure exits the process with its reason on stderr, and without the
  race a readiness wait burns its whole budget and then blames the network.
  The host-side `pollGuestHealth` remains for the subprocess backend, which
  has no probes.

  **The probe INTERVAL is dead time on every spawn**, which is why it is 100ms
  and not Modal's more conversational default: the harness binds its port
  somewhere between two evaluations, so a spawn waits half an interval on
  average after the guest can already serve. The probe is a TCP connect to a
  listening localhost port inside an otherwise-idle container, so the interval
  buys nothing to offset that. It stops at 100ms rather than going lower
  because the probe's RESULT still crosses Modal's control plane to reach the
  host, and below ~100ms that propagation is what dominates. Was 250ms
  (~125ms average waste).
- **An agent spawn's steps are ordered by what they actually depend on**, not
  by the order they read in. Two of them are only incidentally sequential and
  must not be re-serialized (`modal-agent-sandbox.ts`):
  - The bundle write and the env write target different paths and neither
    reads the other, so they go together. Serialized, the tiny env write paid
    a full Modal round trip queued behind the ~8 MB bundle's.
  - `sb.tunnels()` needs nothing but the sandbox to exist, so it is issued
    BEFORE the writes rather than beside the exec that follows them — its
    round trip then runs inside the bundle write's window instead of after it.
    It is `.catch`-contained at the point it is issued, because the await is
    several statements away: a write that throws skips the await entirely, and
    a tunnel lookup rejecting afterwards would be an unhandled rejection —
    a failed spawn turning into a dead server process.

  Both are pinned by tests that fail against the serialized shape, which they
  have to be: the calls are ISSUED in the same order either way, so a
  `write, write, exec` transcript reads identically whether or not anything
  waited. The concurrency test asserts on writes in flight, not on sequence.
- **Transport**: STUDIO guests get a WebSocket control channel the
  host dials through the sandbox's Modal tunnel (`encryptedPorts: [8080]`;
  JSON-RPC on `/ws`) once the probe reports ready — the dial's retry
  (`GUEST_DIAL_TIMEOUT_MS`) stays as a backstop rather than the discovery
  mechanism. AGENT guests get NO channel — readiness is the probe, and the
  host probes `/manage/*` over plain HTTPS. Both are authenticated by a
  per-sandbox bearer token minted at
  spawn and delivered via the EXEC's env (never the sandbox's). The tunnel
  URL is public; the token is what keeps the managed surfaces from being an
  open door.
- **The WEB service PREFERS the database's region; SANDBOXES take that list.**
  `modal_deploy.py`'s `REGIONS` is `["us-east-2", "us-east"]` — a FALLBACK
  LIST, never a single value, because a bare `us-east-2` is what once left a
  `deployed` app with zero tasks, zero bytes and no container logs at all. The
  preference is earned: durable-run journal calls are sequential by
  construction, so an unpinned container put ~460 ms on each — 14 calls and
  ~7.3 s for one 300 KB transcription, against **31.4 ms** for the same calls
  against a local Postgres. Supabase is `us-east-2`, and everything under the
  broad `us-east` is tens of ms from it, so a spill still beats unpinned by two
  orders of magnitude. **The fallback is that BROAD region, not a second
  datacenter**: Modal answers `Regions us-east-1 are not supported` at DEPLOY
  time, so that list shipped nothing while the app served the old revision.
  `MODAL_SANDBOX_REGION` is that list, exported into the image: a run's journal
  calls are the GUEST's and sequential, ~24 ms an op out of region, ~2 ms in
  it. It was unset while a pin meant ONE region, exhausted as
  `Sandbox operation timed out`. Both outages are in
  [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md); `modal-image-inputs.test.ts` pins the
  list, its first entry, that each is deploy-accepted, that it is passed, and
  that the guest export is DERIVED.

- **Orphan cleanup differs per mode.** STUDIO guests: the host's
  WebSocket IS the liveness signal — a host that dies without teardown
  drops its sockets, and the harness self-exits after
  `HARNESS_ORPHAN_TIMEOUT_MS` with no host connected (constants in
  `aai-guest/limits.ts`; the window also covers the boot gap before the
  first dial). AGENT guests have no host socket, so they own their own
  lifecycle instead: self-exit after `AGENT_IDLE_EXIT_MS` with zero
  sessions (see `packages/aai-guest/CLAUDE.md`). Either way, once the exec has
  exited, Modal's `idleTimeoutMs` (`SANDBOX_IDLE_TIMEOUT_SECS`, default
  15 min) terminates the sandbox. These are backstops, not the normal
  path: Modal delivers stop signals to the container's **Python** runtime,
  never to a bare `subprocess.Popen` child, so `run_node`
  (scripts/modal_image.py) forwards SIGTERM/SIGINT to the node process and
  waits — that is the only reason `teardownSandboxes` (retire agent guests,
  dispose the studio broker) runs on scale-in/redeploy at all.
  There is NO host-side idle eviction: the guest owns idleness (agent-mode
  self-exit; the studio broker keeps its own per-project idle sweep), and a
  guest exit detaches its slot via `onSandboxLost`.
- The server itself deploys to Modal too (`modal_deploy.py` in Key files) —
  there is no Docker image or Fly.io deployment anymore.
