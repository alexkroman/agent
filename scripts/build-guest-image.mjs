#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Build the guest sandbox image from `packages/aai-server/guest-image.Dockerfile`.
 *
 * The image both sandbox backends pull. Its recipe used to be assembled through
 * Modal's own image builder, which made it unresolvable outside Modal — see the
 * Dockerfile's header for why that had to change and what got simpler.
 *
 * ## Where the values come from
 *
 * Every ARG the Dockerfile takes is READ OUT OF THE TYPESCRIPT that already
 * declares it, never restated here:
 *
 * | ARG              | Source                                            |
 * | ---------------- | ------------------------------------------------- |
 * | `BASE_IMAGE`     | `DEFAULT_SANDBOX_IMAGE` (modal-context.ts)         |
 * | `SYSTEM_PACKAGES`| `GUEST_SYSTEM_PACKAGES` (modal-system-packages.ts) |
 * | `SDK_SPECS`      | `SDK_PACKAGES` (modal-harness-image.ts) — as PACKED TARBALLS for a local build, or `name@version` for a published one; see `packWorkspaceSdk` |
 * | `GUEST_ROOT`     | `GUEST_ROOT` (modal-harness-image.ts)              |
 *
 * A regex read of a source file is a liability wherever it can fail QUIETLY, so
 * every extractor here throws when its declaration does not match — the same
 * discipline `_patch_paths` in `scripts/modal_image.py` documents, where staging
 * nothing would surface as an ENOENT one layer later with no clue pointing back.
 * `guest-image-dockerfile.test.ts` closes the loop from the other side: it
 * IMPORTS the real constants and asserts these extractors agree with them, so a
 * renamed constant fails a test rather than building a subtly wrong image.
 *
 * The version resolution mirrors `resolveSdkSpecs()` deliberately, including its
 * refusal to accept a range: the image tag and the layer cache both key on these
 * strings, so `@alexkroman1/aai@^8` would let one tag mean two different trees.
 *
 * ## Usage
 *
 * ```sh
 * node scripts/build-guest-image.mjs --print                     # resolve args, build nothing
 * node scripts/build-guest-image.mjs                             # local build, this host's arch
 * node scripts/build-guest-image.mjs --msb                       # …and load it into microsandbox
 * node scripts/build-guest-image.mjs --msb --published-sdk       # …against the SDK on npm instead
 * node scripts/build-guest-image.mjs --print-tag                 # the content-addressed tag
 * node scripts/build-guest-image.mjs --registry ghcr.io/owner \
 *     --platform linux/amd64,linux/arm64 --cache-gha --push      # what CI runs
 * ```
 *
 * ## The tag is computed by the TypeScript that owns the algorithm
 *
 * `--registry` needs the SAME content-addressed tag the server resolves, and
 * that hash is `localHarnessImageTag`'s: `agents.harness_image_tag` records it
 * per deploy, so a second implementation here would be the one place a pinned
 * image could stop resolving. Node runs the TS directly under
 * `--conditions=@dev/source` (which is how the workspace resolves `.ts` sources
 * at all), so this shells out to it rather than reimplementing sha256 over the
 * bundle — including the registry join, which is `guestImageRef`'s.
 *
 * `--push` is required for a multi-platform build: a manifest list cannot be
 * loaded into the local docker image store, and buildx fails late and cryptically
 * if you ask it to, so this refuses up front.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { extractString, extractStringArray, read } from "./build-guest-image-extract.mjs";
import { packWorkspaceSdk } from "./build-guest-image-sdk.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "packages", "aai-server");
const GUEST_DIR = path.join(REPO_ROOT, "packages", "aai-guest");
const DOCKERFILE = path.join(SERVER_DIR, "guest-image.Dockerfile");

/** Default local tag. A registry build passes `--tag` explicitly. */
const DEFAULT_TAG = "aai-guest-harness:local";

/**
 * The stamp filename, spelled here and read by `aai-server/service-boot.ts`.
 *
 * Two spellings of one filename is the ordinary hazard, and the alternative is
 * worse: this script is plain `.mjs` run by node with no bundler, so importing a
 * constant out of a TypeScript module would need a loader. `guest-image-stamp.test.ts`
 * holds the two together instead.
 */
const GUEST_IMAGE_STAMP = ".guest-image-stamp.json";

/** The base image, honouring the same env override the server reads. */
function resolveBaseImage() {
  const declared = extractString(
    path.join(SERVER_DIR, "modal-context.ts"),
    "DEFAULT_SANDBOX_IMAGE",
  );
  return process.env.MODAL_SANDBOX_IMAGE?.trim() || declared;
}

/**
 * `name@version` for each SDK package — EXACT versions, read from what this
 * checkout installed. Mirrors `resolveSdkSpecs()`; see the module doc.
 */
function resolveSdkSpecs() {
  const names = extractStringArray(path.join(SERVER_DIR, "modal-harness-image.ts"), "SDK_PACKAGES");
  const guestPkg = JSON.parse(read(path.join(GUEST_DIR, "package.json")));
  return names.map((name) => {
    const declared = guestPkg.dependencies?.[name] ?? guestPkg.devDependencies?.[name];
    if (!declared) {
      throw new Error(`aai-guest package.json no longer declares SDK package ${name}`);
    }
    const installedPath = path.join(GUEST_DIR, "node_modules", name, "package.json");
    if (!existsSync(installedPath)) {
      throw new Error(
        `SDK package ${name} is declared by aai-guest but not installed at ${installedPath} — ` +
          "run pnpm install before building a guest image",
      );
    }
    const { version } = JSON.parse(read(installedPath));
    if (typeof version !== "string") {
      throw new Error(`SDK package ${name} has no version in ${installedPath}`);
    }
    return `${name}@${version}`;
  });
}

/**
 * Everything the Dockerfile needs, resolved from the tree.
 *
 * `workspaceSdk` is the one input that is not read out of the source: it is a
 * build MODE, and `SDK_SPECS` is where the two forms meet (see the Dockerfile's
 * layer-1 comment).
 */
function resolveBuildArgs({ workspaceSdk }) {
  const harnessImage = path.join(SERVER_DIR, "modal-harness-image.ts");
  const systemPackages = extractStringArray(
    path.join(SERVER_DIR, "modal-system-packages.ts"),
    "GUEST_SYSTEM_PACKAGES",
  );
  const guestRoot = extractString(harnessImage, "GUEST_ROOT");
  return {
    BASE_IMAGE: resolveBaseImage(),
    // SORTED, so reordering the declaration is not a change — the same
    // canonicalization `systemPackageList()` applies.
    SYSTEM_PACKAGES: [...systemPackages].sort().join(" "),
    SDK_SPECS: (workspaceSdk ? packWorkspaceSdk(guestRoot) : resolveSdkSpecs()).join(" "),
    GUEST_ROOT: guestRoot,
  };
}

/**
 * The value after a flag, consumed from the SAME iterator the caller loops over
 * — so `--tag x` advances past `x` and a missing value fails by name.
 */
function nextValue(argv, flag) {
  const { value, done } = argv.next();
  if (done || typeof value !== "string") throw new Error(`${flag} needs a value`);
  return value;
}

/**
 * The pull reference for this tree, computed by `guest-image-source.ts` and
 * `modal-harness-image.ts` — never reimplemented here (see the module doc).
 *
 * A non-zero exit is fatal: the alternative is pushing an image under a tag the
 * server will never ask for, which looks like a successful publish and fails
 * later as an unresolvable pull.
 */
function resolveRef(registry) {
  const program = [
    'import { readFileSync } from "node:fs";',
    'import { localHarnessImageTag } from "../packages/aai-server/modal-harness-image.ts";',
    'import { guestImageRef } from "../packages/aai-server/guest-image-source.ts";',
    // `-e` puts the FIRST user argument at argv[1] — there is no script path
    // in argv at all, so this is slice(1) and not the usual slice(2).
    "const [baseTag, harness, registry] = process.argv.slice(1);",
    'const tag = localHarnessImageTag(baseTag, readFileSync(harness, "utf-8"));',
    "process.stdout.write(registry ? guestImageRef(registry, tag) : tag);",
  ].join("\n");
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--conditions=@dev/source",
      "--input-type=module",
      "-e",
      program,
      resolveBaseImage(),
      path.join(GUEST_DIR, "dist", "harness.mjs"),
      ...(registry ? [registry] : []),
    ],
    { cwd: path.join(REPO_ROOT, "scripts"), encoding: "utf-8" },
  );
  if (status !== 0 || !stdout) {
    throw new Error(`could not compute the guest image tag: ${stderr.trim() || `exit ${status}`}`);
  }
  return stdout.trim();
}

/**
 * The CLI, as two tables rather than a branch chain — which keeps the parser
 * flat and makes the accepted surface readable in one place.
 */
const BOOLEAN_FLAGS = {
  "--msb": "msb",
  "--print": "print",
  "--print-tag": "printTag",
  "--push": "push",
  "--cache-gha": "cacheGha",
  "--published-sdk": "publishedSdk",
};
const VALUE_FLAGS = {
  "--tag": "tag",
  "--registry": "registry",
  "--platform": "platform",
};

/**
 * Whether this build installs THIS CHECKOUT's SDK.
 *
 * A LOCAL image does by default; a published one may never. The polarity is the
 * safety property: the dangerous direction is shipping unpublished code into every
 * tenant's guest, so it takes an explicit registry or push to select the published
 * SDK, and there is no flag that opts a PUSHED image into the workspace one.
 *
 * `--published-sdk` is for the other job this script has — reproducing a report
 * against the SDK a user actually has — and it announces itself, because a local
 * image that is not this checkout is the state that cost an investigation once
 * already.
 */
function resolveSdkMode(opts) {
  if (opts.registry || opts.push) return false;
  if (opts.publishedSdk) {
    console.log("Using the PUBLISHED SDK in a local image (--published-sdk)");
    return false;
  }
  return true;
}

function parseArgv(rawArgv) {
  const opts = {
    tag: undefined,
    registry: undefined,
    platform: undefined,
    push: false,
    print: false,
    printTag: false,
    cacheGha: false,
    msb: false,
    publishedSdk: false,
  };
  const argv = rawArgv[Symbol.iterator]();
  for (const arg of argv) {
    const boolean = BOOLEAN_FLAGS[arg];
    const valued = VALUE_FLAGS[arg];
    if (boolean !== undefined) opts[boolean] = true;
    else if (valued !== undefined) opts[valued] = nextValue(argv, arg);
    else throw new Error(`unknown argument ${arg}`);
  }
  // Both name the image; obeying one silently would push somewhere unintended.
  if (opts.tag && opts.registry) throw new Error("pass --tag or --registry, not both");
  // buildx cannot --load a manifest list, and says so only after the whole
  // build. Refuse up front rather than at the end of a five-minute run.
  // microsandbox keeps its own image store, so loading needs a local image to
  // export — there is nothing to export from a registry push.
  if (opts.msb && opts.push) throw new Error("--msb cannot be combined with --push");
  if (opts.platform?.includes(",") && !opts.push) {
    throw new Error("a multi-platform build must be --push (a manifest list cannot be --load'ed)");
  }
  return { ...opts, workspaceSdk: resolveSdkMode(opts) };
}

/**
 * Fail on a missing build input, naming the command that produces it.
 *
 * Up front rather than as a `COPY` failure inside the build: docker reports a
 * missing context file as a path relative to the context, which is not a path
 * anybody can act on.
 */
function assertBuildContext() {
  const harness = path.join(GUEST_DIR, "dist", "harness.mjs");
  if (!existsSync(harness)) {
    throw new Error(
      `the guest harness is not built at ${path.relative(REPO_ROOT, harness)} — ` +
        "run node scripts/ensure-guest-harness.mjs",
    );
  }
  for (const name of ["package.json", "package-lock.json"]) {
    const file = path.join(GUEST_DIR, "toolchain", name);
    if (!existsSync(file)) {
      throw new Error(
        `guest toolchain ${name} is missing at ${path.relative(REPO_ROOT, file)} — ` +
          "run node scripts/sync-guest-toolchain.mjs",
      );
    }
  }
}

function main(argv) {
  const opts = parseArgv(argv);

  // Before the arg resolution, so `--print-tag` needs no toolchain files.
  if (opts.printTag) {
    console.log(resolveRef(opts.registry));
    return 0;
  }

  const args = resolveBuildArgs({ workspaceSdk: opts.workspaceSdk });

  assertBuildContext();

  // `--registry` derives the content-addressed tag; `--tag` overrides it; a
  // bare local build gets a fixed name, since no registry is involved.
  const tag = opts.tag ?? (opts.registry ? resolveRef(opts.registry) : DEFAULT_TAG);

  const argv2 = [
    "buildx",
    "build",
    "--file",
    DOCKERFILE,
    "--tag",
    tag,
    // Layer cache across runs. `mode=max` keeps the intermediate layers, which
    // is what makes a harness-only change reuse the toolchain install.
    ...(opts.cacheGha ? ["--cache-from", "type=gha", "--cache-to", "type=gha,mode=max"] : []),
    ...(opts.platform ? ["--platform", opts.platform] : []),
    ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
    opts.push ? "--push" : "--load",
    // The CONTEXT is the guest package: it holds `toolchain/` and
    // `dist/harness.mjs`. The Dockerfile lives beside the constants it mirrors
    // instead, which is why `--file` points out of the context.
    GUEST_DIR,
  ];

  if (opts.print) {
    console.log(JSON.stringify({ tag, platform: opts.platform ?? null, args }, null, 2));
    console.log(`\ndocker ${argv2.join(" ")}`);
    return 0;
  }

  console.log(`Building ${tag}${opts.platform ? ` (${opts.platform})` : ""}`);
  const { status, error } = spawnSync("docker", argv2, { stdio: "inherit" });
  if (error) throw error;
  if (status !== 0) return status ?? 1;
  return opts.msb ? loadIntoMicrosandbox(tag) : 0;
}

/**
 * Record WHICH harness the image in microsandbox's store was built from.
 *
 * The local tag is mutable (`aai-guest-harness:local`), so the image and the
 * harness beside it drift silently — and the boot check could only ever see the
 * image MISSING, never the image being two days old. That is not hypothetical:
 * a stale one served pre-change code for an hour of manual testing, printing a
 * diagnostic that had been reworded in the meantime and reporting an SDK version
 * one release back, with nothing anywhere saying the image was the reason.
 *
 * The stamp is the harness's own digest and nothing else, deliberately. It is
 * what changes on essentially every rebuild, both sides can compute it with
 * `node:crypto` alone, and folding in the build args would mean the server
 * re-deriving them from three TypeScript files at boot. A toolchain change with
 * an unchanged harness is therefore NOT caught here — the content-addressed
 * registry tag is what covers that path (`localHarnessImageTag`).
 *
 * Written beside the harness in `dist/`, which is build output and gitignored.
 * `service-boot.ts` is the reader.
 */
function writeImageStamp(tag) {
  const harness = path.join(GUEST_DIR, "dist", "harness.mjs");
  if (!existsSync(harness)) return;
  const digest = createHash("sha256").update(readFileSync(harness)).digest("hex");
  writeFileSync(
    path.join(GUEST_DIR, "dist", GUEST_IMAGE_STAMP),
    `${JSON.stringify({ tag, harnessSha256: digest, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/**
 * Copy a locally-built image into microsandbox's own image store.
 *
 * microsandbox does not read Docker's store — it keeps its own, and a sandbox
 * created from a reference it has never seen fails at boot rather than falling
 * back to the daemon. So the dev flow is an explicit export/import: `docker
 * save` to a tar, `msb load` from it. The tar is ~500 MB and is removed
 * afterwards even when the import fails, since leaving one per build in the
 * temp dir is how a laptop quietly loses a few gigabytes.
 */
function loadIntoMicrosandbox(tag) {
  // `join(tmpdir(), …)`, never a literal path: a hardcoded `/tmp` is
  // drive-relative on Windows (guard-invariants rule 11).
  const archive = path.join(tmpdir(), `aai-guest-image-${process.pid}.tar`);
  try {
    console.log(`Exporting ${tag} for microsandbox`);
    const save = spawnSync("docker", ["save", tag, "-o", archive], { stdio: "inherit" });
    if (save.error) throw save.error;
    if (save.status !== 0) return save.status ?? 1;

    // Through the workspace's own msb, so the CLI and the SDK the server loads
    // are the same pinned version.
    const msb = path.join(SERVER_DIR, "node_modules", ".bin", "msb");
    if (!existsSync(msb)) {
      throw new Error(`microsandbox is not installed at ${msb} — run pnpm install`);
    }
    const load = spawnSync(msb, ["load", "-i", archive, "-t", tag], { stdio: "inherit" });
    if (load.error) throw load.error;
    if (load.status === 0) writeImageStamp(tag);
    return load.status ?? 1;
  } finally {
    rmSync(archive, { force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`build-guest-image: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
