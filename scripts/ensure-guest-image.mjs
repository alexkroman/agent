#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Rebuild the LOCAL guest image when — and only when — its inputs changed.
 *
 * `predev` in aai-studio-server runs this, so `pnpm dev:aai-server` cannot serve
 * a stale microVM. That gap has now cost two investigations, and the reason it is
 * expensive is that the image is invisible from every angle a developer looks
 * from: `ensure-guest-harness.mjs` reports a FRESH `dist/harness.mjs`, the bundle
 * demonstrably contains the change, and the microVM boots an image that has
 * neither (`packages/aai-guest/CLAUDE.md`, "A harness edit needs the IMAGE
 * rebuilt"). The second time, the image was two days old and the guest logged a
 * bug whose fix had been in the tree for an hour.
 *
 * ## Content-addressed, NOT an mtime heuristic
 *
 * The staleness question here is the one the existing checks get wrong. The
 * server's boot check can only see the image MISSING; an mtime comparison answers
 * about a file the VM does not read; and `:local` is a mutable tag, so nothing
 * about the tag itself says what is inside it. So the gate hashes the real
 * inputs — the harness bundle, every SDK `dist` tree the tarballs are packed
 * from, and the resolved build args — and refuses to believe anything else.
 *
 * It also pins the built image's own ID, because the ~500 MB `docker save` →
 * `msb load` round trip is the expensive half and skipping it on an unchanged
 * fingerprint is the whole point. A wiped microsandbox store is therefore the one
 * state this cannot see; `--force` is the answer, and it is one line of output
 * away in the skip message.
 *
 * ## Why not just always build
 *
 * Measured: a warm no-change rebuild is ~46s, plus the export/import on top. The
 * studio front-end is rebuilt unconditionally in the same `predev` on the
 * argument that a stale bundle looks like nothing — the same argument applies
 * here, but at 46s+ per `pnpm dev` it would buy correctness with a cost
 * developers route around, and a gate people bypass protects nothing. An exact
 * fingerprint gets the same guarantee for ~1s.
 *
 * ## What it deliberately does NOT do
 *
 * Fail the dev server. A developer with no docker running, or on the
 * `subprocess` backend, does not need an image at all — so an unbuildable image
 * WARNS and exits 0. The server's own boot check is the backstop, and it names
 * the command.
 *
 * ## Usage
 *
 * ```sh
 * node scripts/ensure-guest-image.mjs            # build if the inputs moved
 * node scripts/ensure-guest-image.mjs --force    # build regardless
 * node scripts/ensure-guest-image.mjs --check    # report only, exit 1 if stale
 * ```
 *
 * @module ensure-guest-image
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseScriptArgs } from "./_args.mjs";
import { extractString, extractStringArray } from "./build-guest-image-extract.mjs";
import { sdkSourceDigest } from "./build-guest-image-sdk.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "packages", "aai-server");
const GUEST_DIR = path.join(REPO_ROOT, "packages", "aai-guest");
const HARNESS = path.join(GUEST_DIR, "dist", "harness.mjs");

/**
 * Where the last successful build's fingerprint is recorded.
 *
 * `node_modules/.cache`, not `packages/aai-guest/dist/`. It belongs in neither the
 * repo nor a clone — a fingerprint is a statement about one machine's docker store
 * — but `dist/` is the wrong kind of untracked: `tsdown` CLEANS it, so any build
 * of the guest deleted the file and the next `pnpm dev` paid a full image rebuild
 * for nothing. Caught the first time this ran after `pnpm check:local`.
 *
 * Deliberately NOT `.guest-image-stamp.json`, which the SERVER reads at boot,
 * whose contract is the harness digest alone, and which lives in `dist/` for the
 * opposite reason — it SHOULD die with the harness it describes
 * (`build-guest-image.mjs`'s `writeImageStamp` argues why it stays that narrow).
 */
const FINGERPRINT_FILE = path.join(
  REPO_ROOT,
  "node_modules",
  ".cache",
  "aai-guest-image-inputs.json",
);

/**
 * Code-unit order, never `localeCompare`: with no explicit locale that answers to
 * the runtime's ICU default, so the same tree would fingerprint differently on two
 * machines and the gate would rebuild for a locale change.
 */
const byCodeUnit = (a, b) => (a < b ? -1 : Number(a > b));

/** The image a local build produces, and the only one this gate manages. */
const LOCAL_TAG = "aai-guest-harness:local";

/**
 * Everything a local image is built from, as one digest.
 *
 * The build ARGS are in it as well as the code: a base-image bump or a new entry
 * in `GUEST_SYSTEM_PACKAGES` changes what the image is without touching a single
 * byte of the harness or the SDK, and that is exactly the class of change nobody
 * thinks to rebuild for.
 */
function fingerprint() {
  // `\0` as the separator, spelled as an ESCAPE rather than typed: a raw NUL
  // makes a whole file BINARY to `git grep`, which silently exempts it from every
  // line rule and every escape-hatch pattern — the trap `assertScanCorpus`
  // exists to catch, and it caught this file on its first run. The byte is
  // identical; the file stays text. It earns its place as a separator because it
  // cannot occur in a digest, a tag or a package name.
  const hash = createHash("sha256");
  hash.update(readFileSync(HARNESS));
  hash.update(`\0sdk:${sdkSourceDigest()}\0`);
  const harnessImage = path.join(SERVER_DIR, "modal-harness-image.ts");
  hash.update(
    `base:${extractString(path.join(SERVER_DIR, "modal-context.ts"), "DEFAULT_SANDBOX_IMAGE")}\0`,
  );
  hash.update(`root:${extractString(harnessImage, "GUEST_ROOT")}\0`);
  hash.update(
    `apt:${extractStringArray(
      path.join(SERVER_DIR, "modal-system-packages.ts"),
      "GUEST_SYSTEM_PACKAGES",
    )
      .sort(byCodeUnit)
      .join(" ")}`,
  );
  return hash.digest("hex");
}

/** The local image's docker ID, or undefined when docker cannot answer. */
function localImageId() {
  const { status, stdout } = spawnSync(
    "docker",
    ["image", "inspect", LOCAL_TAG, "--format", "{{.Id}}"],
    { encoding: "utf-8" },
  );
  return status === 0 ? stdout.trim() || undefined : undefined;
}

function readFingerprint() {
  if (!existsSync(FINGERPRINT_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8"));
    return typeof parsed?.inputs === "string" ? parsed : undefined;
  } catch {
    // Truncated, or written by an older shape. Same answer as no stamp at all —
    // rebuild — but said out loud, because silently rebuilding every time is the
    // failure mode a developer would experience as "the gate does nothing".
    console.warn(`ensure-guest-image: ignoring unreadable ${path.basename(FINGERPRINT_FILE)}`);
  }
}

/**
 * Why a rebuild is owed, or undefined when it is not.
 *
 * A REASON rather than a boolean, because every one of these is a state a
 * developer has been confused by, and printing which one it was is most of the
 * value this script adds.
 */
function stale(inputs) {
  const recorded = readFingerprint();
  if (!recorded) return "no local image has been built from this checkout";
  if (recorded.inputs !== inputs) return "the harness, the SDK or a build arg changed";
  const id = localImageId();
  if (id === undefined) return `docker has no ${LOCAL_TAG}`;
  if (id !== recorded.imageId) return `${LOCAL_TAG} was rebuilt by something else`;
}

function main(argv) {
  const { values: flags } = parseScriptArgs({
    script: import.meta.url,
    options: { force: { type: "boolean" }, check: { type: "boolean" } },
    argv,
  });
  const force = flags.force === true;
  const checkOnly = flags.check === true;

  // The `subprocess` backend runs the guest as a child process on the host's own
  // network stack and reads `dist/harness.mjs` directly — there is no image in
  // that path, so building one is pure cost.
  if (process.env.SANDBOX_BACKEND?.trim().toLowerCase() === "subprocess") {
    console.log("ensure-guest-image: SANDBOX_BACKEND=subprocess needs no image — skipping");
    return 0;
  }

  if (!existsSync(HARNESS)) {
    // Ordering, not an error: `predev` runs `ensure-guest-harness.mjs` first, and
    // a caller who skipped it gets told which command produces the input.
    console.warn(
      `ensure-guest-image: no harness at ${path.relative(REPO_ROOT, HARNESS)} — ` +
        "run node scripts/ensure-guest-harness.mjs first. Skipping.",
    );
    return 0;
  }

  const inputs = fingerprint();
  const reason = force ? "--force" : stale(inputs);
  if (!reason) {
    console.log(`ensure-guest-image: ${LOCAL_TAG} is current`);
    return 0;
  }
  if (checkOnly) {
    console.error(`ensure-guest-image: ${LOCAL_TAG} is STALE — ${reason}`);
    return 1;
  }

  console.log(`ensure-guest-image: rebuilding ${LOCAL_TAG} — ${reason}`);
  const { status, error } = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "build-guest-image.mjs"), "--msb"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (error || status !== 0) {
    // WARN and succeed: a developer without docker still gets a dev server, and
    // the server's own boot check names this command when a guest needs an image.
    console.warn(
      "ensure-guest-image: the image build did not succeed. `aai dev` and the " +
        "subprocess backend are unaffected; a microVM guest will fail to spawn " +
        "until `pnpm build:guest-image --msb` works.",
    );
    return 0;
  }

  // AFTER the build, and only on success: a fingerprint recorded for a build that
  // failed halfway is the one thing worse than no fingerprint, because the next
  // run would skip.
  mkdirSync(path.dirname(FINGERPRINT_FILE), { recursive: true });
  writeFileSync(
    FINGERPRINT_FILE,
    `${JSON.stringify({ inputs, imageId: localImageId() ?? null, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`ensure-guest-image: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export { FINGERPRINT_FILE, fingerprint, LOCAL_TAG, stale };
