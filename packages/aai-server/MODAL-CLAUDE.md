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
(`packages/aai-templates/claude-md-limit.test.ts`) globs `packages/*/CLAUDE.md`
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
