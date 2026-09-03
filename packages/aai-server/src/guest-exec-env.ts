// Copyright 2026 the AAI authors. MIT license.
/**
 * The exec env every CONTAINED guest gets — the whole of it, in one builder.
 *
 * Split out of `modal-harness-image.ts`, which had grown two jobs: BUILDING the
 * harness-baked snapshot image, and declaring what a process exec'd inside one is
 * handed. The seam is worth having for a reason beyond size — this half is a
 * CONTRACT four spawn sites read and the other half is a recipe one resolver runs,
 * and they change for unrelated reasons. It cost something concrete: the file sat
 * at 494 of its 500-line cap, so `TMPDIR` was added to the three env builders
 * AROUND {@link guestExecBaseEnv} rather than into it, and one value had three
 * homes.
 *
 * `modal-harness-image.ts` re-exports every name here, so no import site moved.
 *
 * ## The four sites, and the one that is deliberately not among them
 *
 * `modal-sandbox.ts` and `microsandbox-sandbox.ts` (studio guests) and
 * `modal-agent-sandbox.ts` / `microsandbox-agent-sandbox.ts` (deployed agents) all
 * build their exec env from this. `subprocess-sandbox.ts` does NOT, and must not:
 * its "guest" is a child process on a developer's own machine, so neither the
 * containment declaration nor {@link GUEST_SCRATCH_DIR} is true there — and
 * `/var/tmp` is DRIVE-RELATIVE on Windows, which is the trap `guard-invariants`
 * rule 11 exists for. That backend names what it needs one key at a time.
 */

import { CONTAINED_ENV } from "@alexkroman1/aai-runtime/internal";

/** Root the guest toolchain and harness live under inside the baked image. */
export const GUEST_ROOT = "/opt/aai";

/** Where the guest harness lives inside the baked image. */
export const HARNESS_REMOTE_PATH = `${GUEST_ROOT}/harness.mjs`;

/** Where the harness's baked V8 compile cache lives inside the image. */
export const HARNESS_COMPILE_CACHE_PATH = `${GUEST_ROOT}/.compile-cache`;

/**
 * Where a CONTAINED guest's scratch files go — `TMPDIR`, what `os.tmpdir()`
 * answers inside the sandbox. Under the local microVM `/tmp` is
 * `tmpfs … size=524288k`: a **512 MiB RAM disk**, measured in a live guest,
 * beside the 3.9 GB overlay at `/` that `/var/tmp` sits on. That ceiling
 * falsified the promise `@alexkroman1/aai/step-files` opens with, "nothing here
 * holds a whole recording in memory at any point" — `withTempDir` is
 * `join(tmpdir(), …)` and a step needs a real seekable file (that module says
 * why), so a recording was in RAM under another name and a 660.8 MB source died
 * at 512 MiB with `ENOSPC` after ~5.5 s, four attempts running. Peak scratch is
 * source plus output: ~2.2 GB at the `MAX_WORKFLOW_UPLOAD_BYTES` ceiling.
 * `/var/tmp` belongs to the shared base IMAGE rather than to either sandbox
 * runtime, which makes one value right for both backends — and Modal never had
 * the tmpfs at all (one `none / overlay rw` in `/proc/mounts`; 5.1 GB of `dd`
 * into `/var/tmp` neither `ENOSPC`'d nor OOM-killed a 1 GiB sandbox), so this
 * changes nothing in production and is set there anyway: which runtime mounts
 * what over `/tmp` is not a fact a spawner should know.
 */
export const GUEST_SCRATCH_DIR = "/var/tmp";

/**
 * The exec env EVERY contained guest gets, whatever its mode — one builder so the
 * four exec sites cannot drift on it.
 *
 * `NODE_COMPILE_CACHE` points at the V8 compile cache baked into the image.
 * The harness is a single ~13 MB bundle and every sandbox boots it cold, so
 * V8 spends the same parse+compile on every spawn; populating the cache once
 * during the image build and snapshotting it (see `warmCompileCache`) turns
 * that into a cache read. Measured on the real bundle: **~545ms without,
 * ~343ms with** — ~200ms off every cold voice session, every studio broker
 * call, for ~1.5 MB in the image. A missing or
 * stale entry is a silent MISS, never an error (a cache written by a different
 * Node version, or for different file content, is simply ignored), which is
 * what makes it safe to bake in. Modal-only on purpose: the cache is a
 * property of the baked image, and the subprocess backend has no image to bake
 * one into.
 *
 * CONTAINED declares that a real container surrounds this guest, so the SDK's
 * network builtins drop their SSRF screen — it guards nothing a tenant cannot
 * bypass with a raw fetch from their own tool code, and the container holds no
 * platform credentials. Declared by the SPAWNER rather than sniffed by the
 * guest, and deliberately absent from the subprocess backend, whose "guest" is
 * a child process on the developer's own machine (see aai/host/ssrf.ts).
 *
 * `TMPDIR` is here for the same reason containment is DECLARED rather than
 * sniffed: inherited, `os.tmpdir()` answers whatever the sandbox runtime mounted,
 * and one of the two runtimes mounts a 512 MiB RAM disk over `/tmp`
 * ({@link GUEST_SCRATCH_DIR} has the measurement). It used to be set by the two
 * studio spawn sites and by `agentBootEnv` — three copies of one value, which is
 * exactly what a "one builder so the sites cannot drift" env is for, and the
 * three existed only because this file was one line from its length cap. The one
 * spawner it must NOT reach is `subprocess`; see the module doc.
 */
export function guestExecBaseEnv(): Record<string, string> {
  return {
    NODE_COMPILE_CACHE: HARNESS_COMPILE_CACHE_PATH,
    [CONTAINED_ENV]: "1",
    TMPDIR: GUEST_SCRATCH_DIR,
  };
}
