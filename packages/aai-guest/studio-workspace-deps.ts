// Copyright 2026 the AAI authors. MIT license.
/**
 * Reify a workspace's OWN package.json — put the packages its `dependencies`
 * declare on disk before anything tries to build against them.
 *
 * A workspace manifest is not decoration: `ensureProjectShape` writes one, the
 * coding agent edits it (through `add_dependency` or by hand), and a project
 * pushed with `aai push` brings its own. But until now the only thing that ever
 * put a package on disk was `add_dependency` running in that exact directory,
 * in that exact session — and a workspace directory does not survive either
 * boundary it has to cross:
 *
 * - `materializeWorkspace` opens with `rm -rf`, so a session RE-install (a page
 *   refresh, a replica taking the session over) deletes `node_modules` while
 *   package.json goes on declaring what used to be in it;
 * - Publish builds a FRESH directory from the store snapshot (`withBuildDir`),
 *   which never had a `node_modules` at all;
 * - and a project pushed from a laptop arrives with a manifest whose
 *   dependencies were only ever installed on the laptop.
 *
 * All three end the same way. The worker bundle is built `ssr: { noExternal:
 * true }` — everything is bundled, because the guest that loads it has no
 * node_modules — so an unresolvable bare import is not externalized, it is a
 * hard build failure: `Rolldown failed to resolve import "ms"`, naming a
 * package the manifest plainly declares. The agent tested fine and Publish
 * died, which is the worst shape that failure could take.
 *
 * **`dependencies` only.** Those are what `agent.ts` and `client.tsx` import,
 * so those are what the bundle needs. `devDependencies` are the TOOLCHAIN
 * (vite, typescript, vitest, the `@types/*`), which is baked into the guest
 * image and resolves by the normal walk-up — a pushed scaffold manifest
 * declares all of them, and installing that set per publish would be a large
 * download arriving back where we started.
 *
 * **The install goes to the SHARED workspaces root, not into the workspace,
 * and it installs only what is missing.** Both halves are measured rather than
 * stylistic. `npm install` in the workspace reifies the WHOLE manifest —
 * there is no npm flag that adds one package without resolving the rest — and
 * the rest is the toolchain: installing `ms` into a workspace took **25s and
 * 156 MB**, of which all but 28 KB was a registry copy of the SDK, React and
 * Tailwind that already sat one directory up. The same package, resolved
 * through a manifest naming only IT, took **358ms and 28 KB**. Two other
 * properties come with that:
 *
 * - **No shadowing.** A workspace-local copy of a toolchain package shadows
 *   the baked one the harness resolved (see `reconcileWorkspacePins` for why
 *   that is only safe while the pins are exact). Not fetching them at all
 *   retires the hazard rather than staying on the right side of it.
 * - **A toolchain pin cannot fail a custom package's install.** npm resolves
 *   a manifest as a WHOLE, so any unreachable entry fails every other package
 *   in the file — and the manifest npm reads here contains only the names that
 *   are actually missing. That is also why {@link installShared} runs npm once
 *   PER PACKAGE: staging two missing packages together would put them back in
 *   one resolution, where a bogus name takes the good one down with it.
 *
 * The root (`.workspaces/`) is the directory every session workspace and every
 * Publish build dir is created UNDER, so its `node_modules` is on all of their
 * resolution paths by Node's ordinary walk-up — verified, not assumed — while
 * being outside every one of them, so nothing here syncs to the store and
 * `materializeWorkspace`'s `rm -rf` cannot reach it. A sandbox serves exactly
 * one project (its identity is pinned at first install), so sharing the tree
 * across that project's session and its publish builds is sharing it with
 * itself — and it means a package installed once during the session is already
 * there when Publish materializes its fresh directory.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { createKeyedLock, withLock } from "@alexkroman1/aai/utils";
import { envWithoutGuestToken, runCapped } from "./studio-spawn.ts";

/** Wall-clock limit for the one install this module runs. */
const INSTALL_TIMEOUT_MS = 110_000;

/** Output tail kept from npm (errors print last). */
const INSTALL_OUTPUT_CAP = 4000;

/** npm package name: optional scope, then the name. No version part. */
const DEPENDENCY_NAME_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/;

/**
 * The version specs worth copying into the shared manifest: semver ranges and
 * dist-tags. `:` and `/` are excluded, which refuses every spec that is really
 * a LOCATION rather than a version (`file:../x`, `git+ssh://…`,
 * `github:owner/repo`, `npm:alias@1`). A relative location is the reason to
 * bother: it would resolve against the shared root rather than the workspace
 * that wrote it, so copying one across would quietly mean something else.
 */
const VERSION_SPEC_RE = /^[\w.^~<>=*+ |-]+$/;

/**
 * Where the shared install lives, and the two files it owns. Named off the
 * workspaces root the caller passes in, so this module stays clear of
 * `studio-build.ts`, which calls it.
 */
const sharedManifestPath = (sharedRoot: string): string => path.join(sharedRoot, "package.json");

export type WorkspaceDependencyOptions = {
  /** The `.workspaces/` root every workspace and build dir sits under. */
  sharedRoot: string;
  /** The baked toolchain's `node_modules`, or null when it can't be found. */
  toolchainModules: string | null;
};

/** Read and parse a JSON file, or null when it is missing/unparseable. */
async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

/** A manifest's `dependencies` as a plain record — `{}` for any other shape. */
function dependenciesOf(manifest: unknown): Record<string, string> {
  const declared = (manifest as { dependencies?: unknown } | null)?.dependencies;
  return declared && typeof declared === "object" ? (declared as Record<string, string>) : {};
}

export type DependencyPlan = {
  /** `name → spec` for the packages to add to the shared manifest. */
  install: Record<string, string>;
  /** Named, per-entry reasons something declared was left out. Never silent. */
  skipped: string[];
};

/**
 * What of `manifest`'s runtime dependencies still needs installing.
 *
 * `isResolvable` answers for every place a bare import can come from — the
 * workspace's own `node_modules`, the shared root's, and the baked toolchain's.
 *
 * A manifest that is not an object, or whose `dependencies` is not one, plans
 * nothing rather than throwing: the agent may be mid-edit, and npm reports a
 * broken manifest far better than a crash here would.
 */
export function planWorkspaceDependencies(
  manifest: unknown,
  isResolvable: (name: string) => boolean,
): DependencyPlan {
  const install: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [name, spec] of Object.entries(dependenciesOf(manifest))) {
    if (isResolvable(name)) continue;
    if (!DEPENDENCY_NAME_RE.test(name)) {
      skipped.push(`${name}: not a valid npm package name`);
    } else if (typeof spec !== "string" || !VERSION_SPEC_RE.test(spec)) {
      skipped.push(`${name}: "${String(spec)}" is not a version or range this can install`);
    } else {
      install[name] = spec;
    }
  }
  return { install, skipped };
}

/**
 * One installer at a time per shared root. Two builds can overlap in this
 * process — a Publish while the chat's `test_agent` build runs — and npm takes
 * no lock of its own, so concurrent reifications of the same tree would race
 * both the manifest read-modify-write and `node_modules` itself.
 */
const installLock = createKeyedLock();

/**
 * Install `dir`'s declared runtime dependencies when any of them are missing.
 *
 * Returns null when there was nothing to do or every declared package is
 * resolvable afterwards, and otherwise a diagnostic naming what is still
 * missing — prose for the coding agent, which is the reader that can act on it.
 * It is a WARNING rather than a thrown error on purpose: a manifest can name a
 * package no source file imports, and failing a publish over one would be a
 * regression against the build that used to succeed by ignoring the manifest.
 */
export async function ensureWorkspaceDependencies(
  dir: string,
  opts: WorkspaceDependencyOptions,
): Promise<string | null> {
  const manifest = await readJson(path.join(dir, "package.json"));
  if (manifest === null) return null;

  const { sharedRoot, toolchainModules } = opts;
  const isResolvable = (name: string): boolean =>
    existsSync(path.join(dir, "node_modules", name)) ||
    existsSync(path.join(sharedRoot, "node_modules", name)) ||
    (toolchainModules !== null && existsSync(path.join(toolchainModules, name)));

  const plan = planWorkspaceDependencies(manifest, isResolvable);
  if (Object.keys(plan.install).length === 0) {
    return plan.skipped.length === 0 ? null : describeMissing([], plan, "");
  }

  const output = await withLock(installLock, sharedRoot, async () => {
    // Re-planned inside the lock: an overlapping build may have installed
    // exactly these while this one waited, and re-running npm for a tree that
    // already satisfies us is the whole cost this module exists to avoid.
    const fresh = planWorkspaceDependencies(manifest, isResolvable).install;
    return Object.keys(fresh).length === 0
      ? ""
      : await installShared(sharedRoot, fresh, isResolvable);
  });

  // The install's exit code is not the question — whether the imports resolve
  // now is. npm exits 0 having installed nothing when an entry is optional,
  // and exits nonzero after installing the package that mattered.
  const stillMissing = Object.keys(plan.install).filter((name) => !isResolvable(name));
  if (stillMissing.length === 0 && plan.skipped.length === 0) return null;
  return describeMissing(stillMissing, plan, output);
}

/**
 * Install `specs` into the shared root, ONE PACKAGE PER npm RUN, and report
 * what each failure said.
 *
 * One at a time because npm resolves a manifest as a WHOLE: staged together,
 * a single unreachable package fails the install of every other one in the
 * file — verified, not assumed (a bogus name alongside `ms` and `date-fns`
 * left all three uninstalled). One run each costs a few hundred milliseconds
 * per package against a warm tree, and it is what makes a bad manifest entry
 * cost only itself.
 *
 * A package that did not arrive is REMOVED from the staged manifest again.
 * Left in, it is not merely a failure once — it is in the file every later
 * install reads, so one bad entry would permanently break installing anything
 * else in this sandbox.
 */
async function installShared(
  sharedRoot: string,
  specs: Record<string, string>,
  isResolvable: (name: string) => boolean,
): Promise<string> {
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const output = await installOne(sharedRoot, name, spec);
    if (isResolvable(name)) continue;
    failures.push(`${name}: ${output || "(npm produced no output)"}`);
    await stage(sharedRoot, (deps) => {
      delete deps[name];
      return deps;
    });
  }
  return failures.join("\n");
}

/** Stage one package into the shared manifest and reify it. */
async function installOne(sharedRoot: string, name: string, spec: string): Promise<string> {
  try {
    await stage(sharedRoot, (deps) => ({ ...deps, [name]: spec }));
  } catch (err) {
    return `could not stage the install manifest: ${errorMessage(err)}`;
  }
  try {
    const result = await runCapped(
      "npm",
      // `--omit=peer` for the same reason as `--omit=dev`: a peer dependency
      // says "the host provides this", and here the host is the baked
      // toolchain. Installed, a package's `react` peer would hoist into the
      // shared root and SHADOW the toolchain's for every workspace under it,
      // silently changing the React the client bundle is built against. Left
      // out, a peer the toolchain really lacks fails the build by name, which
      // the agent can answer with `add_dependency`.
      ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", "--loglevel=error"],
      {
        cwd: sharedRoot,
        env: envWithoutGuestToken(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        cap: INSTALL_OUTPUT_CAP,
        combineStreams: true,
      },
    );
    return result.signal
      ? `killed by ${result.signal} after ${INSTALL_TIMEOUT_MS}ms`
      : result.stdout.trim();
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Read-modify-write the shared manifest's `dependencies`.
 *
 * Modified rather than replaced: the tree is shared across this project's
 * session workspace and its publish build dirs, and npm PRUNES whatever the
 * manifest it reads no longer declares — so writing only the current call's
 * packages would uninstall an earlier one's, out from under a build still
 * importing it.
 */
async function stage(
  sharedRoot: string,
  update: (deps: Record<string, string>) => Record<string, string>,
): Promise<void> {
  const manifestPath = sharedManifestPath(sharedRoot);
  await mkdir(sharedRoot, { recursive: true });
  const dependencies = update(dependenciesOf(await readJson(manifestPath)));
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      { name: "aai-workspace-deps", private: true, type: "module", dependencies },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

/** The chat-facing diagnostic: what is unusable, why, and npm's own tail. */
function describeMissing(missing: string[], plan: DependencyPlan, output: string): string {
  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(
      `Could not install ${missing.join(", ")} — declared in package.json, but not ` +
        "resolvable, so any import of them will fail to build. Check the name and " +
        "version, or remove the entry.",
      output || "(npm produced no output)",
    );
  }
  for (const note of plan.skipped) lines.push(`Skipped ${note}`);
  return lines.join("\n");
}

/**
 * Put a dependency-install warning ahead of the failure it most likely caused.
 *
 * Only on a FAILURE: a manifest can name a package no source file imports, so
 * an install that could not satisfy it is not by itself a broken build, and
 * saying so on a green one would train the reader to skip the line. On a red
 * one it is usually the cause, and it reads far better than the bundler's bare
 * "failed to resolve import" does on its own.
 */
export function withDependencyWarning(warning: string | null, failure: string): string {
  return warning === null ? failure : `${warning}\n\n${failure}`;
}
