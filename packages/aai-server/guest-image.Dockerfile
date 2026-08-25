# Copyright 2026 the AAI authors. MIT license.
#
# The guest sandbox image — ONE recipe, built once, pulled by every backend.
#
# This is the OCI form of what `modal-harness-image.ts` used to assemble through
# Modal's own image builder. It exists because a Modal image is not an artifact
# anything outside Modal can resolve: it was built from `dockerfileCommands`,
# finished with a `snapshotFilesystem()` of a throwaway sandbox, and published
# under a Modal-internal name reachable only via `images.fromName()`. So a local
# backend could not run production's guest environment even in principle — it had
# to grow a second toolchain delivery mechanism, which is the cost that sank the
# previous local-container attempt (see "Two tiers, deliberately" in
# `sandbox-backend.ts`).
#
# Two things get SIMPLER by moving here, both for the same reason — a Docker
# build has a build CONTEXT and `dockerfileCommands` does not:
#
#   * The ~17 MB harness bundle is a `COPY` (measured: 0.2s), replacing a
#     throwaway builder sandbox, a `filesystem.writeText` of the whole bundle,
#     a `snapshotFilesystem()` and an image `publish()`.
#   * The toolchain manifest and lockfile are `COPY`s, replacing a
#     gzip+base64 blob embedded in a `RUN echo … | base64 -d | gunzip` line.
#
# ## The layer order is load-bearing
#
# Same order, and the same reason, as the Modal layers it replaces: the halves
# change at completely different rates. System packages change almost never; the
# toolchain changes on an SDK release; the harness changes on EVERY server code
# change. Cheapest-to-invalidate goes last, so the common case (a harness
# rebuild) reuses everything above it.
#
# ## Every input is an ARG, and an empty one FAILS the build
#
# The values come from `modal-system-packages.ts` and `modal-harness-image.ts`
# (`GUEST_SYSTEM_PACKAGES`, `SDK_PACKAGES`, `GUEST_ROOT`, `DEFAULT_SANDBOX_IMAGE`)
# by way of `scripts/build-guest-image.mjs`, so there is one source of truth for
# them and `guest-image-dockerfile.test.ts` fails if this file drifts from it.
# Docker does not error on an unset ARG — it substitutes an empty string — so
# each one is guarded explicitly. An unguarded SDK_SPECS would produce a green
# image with no SDK in it, and the symptom would be every guest failing to
# resolve `@alexkroman1/aai` at run time.
#
# Build it with `node scripts/build-guest-image.mjs`, never by hand: the context
# must be the aai-guest package (it holds `toolchain/` and `dist/harness.mjs`)
# while this file lives beside the constants it mirrors.

# Defaulted so a bare `docker build` works and buildx does not warn
# (InvalidDefaultArgInFrom) on every run. It is a COPY of `DEFAULT_SANDBOX_IMAGE`,
# and `guest-image-dockerfile.test.ts` fails when the two disagree — the same
# committed-copy-plus-gate shape as the scaffold manifest. `SYSTEM_PACKAGES` and
# `SDK_SPECS` deliberately get NO default: the SDK versions change every release,
# so a stale default there would build a wrong image silently rather than loudly.
ARG BASE_IMAGE=node:26-slim
FROM ${BASE_IMAGE}

ARG GUEST_ROOT=/opt/aai
ARG SYSTEM_PACKAGES
ARG SDK_SPECS

# ── Layer 0: system packages (GUEST_SYSTEM_PACKAGES) ─────────────────────────
#
# `--no-install-recommends` because ffmpeg's recommends pull an X stack the guest
# has no display for, and the apt lists are dropped with the layer that fetched
# them: a cached index is bytes on every sandbox's cold-start path and stale
# within a day besides.
RUN test -n "${SYSTEM_PACKAGES}" \
      || { echo "SYSTEM_PACKAGES is empty — see GUEST_SYSTEM_PACKAGES in modal-system-packages.ts" >&2; exit 1; } \
 && apt-get update \
 && apt-get install -y --no-install-recommends ${SYSTEM_PACKAGES} \
 && rm -rf /var/lib/apt/lists/*

# ── Layer 1: the guest toolchain ─────────────────────────────────────────────
#
# Two steps, and the split is forced (the long form is in
# `scripts/sync-guest-toolchain.mjs`):
#
#   1. `npm ci` against the COMMITTED manifest + lockfile, so the third-party
#      tree — where nearly all the transitive surface lives — is byte-identical
#      to what this repo tested with, whenever and wherever this is built. `npm
#      ci` also refuses to run when the two disagree, so a hand-edited manifest
#      fails the BUILD.
#   2. `npm install` of the SDK packages at exact resolved versions, which
#      cannot be locked here: their versions change every release and a lockfile
#      entry needs an integrity hash that only exists once the version is
#      published — after the commit that bumps it.
#
# `--ignore-scripts` on BOTH. npm 11.19 reports an unreviewed install script and
# then runs it anyway (the skip in arborist is gated on an explicit deny), so
# without this the notice describes code that has already executed in the build
# producing every tenant's guest image. Step 2 is the sharp one, being unlocked
# by construction: a hijacked transitive arrives there with no integrity hash to
# fail against.
WORKDIR ${GUEST_ROOT}
COPY toolchain/package.json      ${GUEST_ROOT}/package.json
COPY toolchain/package-lock.json ${GUEST_ROOT}/package-lock.json
RUN npm ci --no-audit --no-fund --ignore-scripts
RUN test -n "${SDK_SPECS}" \
      || { echo "SDK_SPECS is empty — see SDK_PACKAGES in modal-harness-image.ts" >&2; exit 1; } \
 && npm install --prefix ${GUEST_ROOT} --no-audit --no-fund --ignore-scripts ${SDK_SPECS}

# ── Layer 2: the harness ─────────────────────────────────────────────────────
#
# What needed a builder sandbox and a filesystem snapshot on Modal. Last, so a
# harness rebuild — every server code change — invalidates nothing above it.
COPY dist/harness.mjs ${GUEST_ROOT}/harness.mjs

# ── Layer 3: the harness's V8 compile cache ──────────────────────────────────
#
# The harness is one ~17 MB bundle and every sandbox boots it cold, so V8 pays
# the same parse+compile on every spawn. Warm-up mode evaluates the module,
# opens nothing, and exits 0; `guestExecBaseEnv()` points every guest exec at
# the resulting cache. Measured on the real bundle: ~570ms -> ~345ms.
#
# BEST-EFFORT, exactly as on Modal: the cache is an optimization and the image
# without it is a working image, so a failure must not fail the build. It is
# still LOUD, because the failure is otherwise invisible — the image builds,
# every guest boots, and the 200ms comes back forever with nothing reporting it.
RUN NODE_COMPILE_CACHE=${GUEST_ROOT}/.compile-cache AAI_GUEST_WARMUP=1 \
      node ${GUEST_ROOT}/harness.mjs \
    || echo "WARN: harness compile-cache warm-up failed; guests will boot uncached" >&2
