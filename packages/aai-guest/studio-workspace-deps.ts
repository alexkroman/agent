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
 * The root (`.workspaces/<pid>/`) is the directory every session workspace and
 * every Publish build dir is created UNDER, so its `node_modules` is on all of
 * their resolution paths by Node's ordinary walk-up — verified, not assumed —
 * while being outside every one of them, so nothing here syncs to the store and
 * `materializeWorkspace`'s `rm -rf` cannot reach it. A package installed once
 * during the session is therefore already there when Publish materializes its
 * fresh directory.
 *
 * **The `<pid>` is what makes "shared with itself" true** (see
 * `workspacesRoot`). The argument for sharing is that a sandbox serves exactly
 * one project — but the path is a property of the harness FILE, and under the
 * subprocess backend every sandbox on the machine runs the same one. Without
 * the pid, two projects share a staged manifest that `npm install` prunes
 * against, and `installLock` is in-process so it cannot see the other. Scoping
 * the root to the process makes the premise hold and the lock sufficient.
 *
 * This module decides WHAT a workspace still needs and reports what it could
 * not get; `studio-shared-install.ts` owns how a package gets into the shared
 * tree — the staged manifest, the npm run, the budget, the failure memo, and
 * the shadowing check.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { createKeyedLock, withLock } from "@alexkroman1/aai/utils";
import {
  dependenciesOf,
  type InstallFailure,
  installShared,
  LOCK_ACQUIRE_TIMEOUT_MS,
  readJson,
  rememberedFailure,
  sharedManifestPath,
} from "./studio-shared-install.ts";
import { PACKAGE_NAME_RE } from "./studio-spawn.ts";

export { resetFailedInstalls, SESSION_INSTALL_BUDGET_MS } from "./studio-shared-install.ts";

/**
 * The version specs worth copying into the shared manifest: semver ranges and
 * dist-tags. `:` and `/` are excluded, which refuses every spec that is really
 * a LOCATION rather than a version (`file:../x`, `git+ssh://…`,
 * `github:owner/repo`, `npm:alias@1`). A relative location is the reason to
 * bother: it would resolve against the shared root rather than the workspace
 * that wrote it, so copying one across would quietly mean something else.
 *
 * The quantifier is `*`, not `+`: `"pkg": ""` is legal npm and means `*`
 * (verified against the registry), so a `+` here refused an ordinary
 * declaration and then let the build fail to resolve it. This stays a charset
 * allowlist rather than a parser — `npm-package-arg` classifies a spec
 * properly and costs a 3.4 MB dependency tree to do it, which is not a trade
 * a 13 MB harness bundle should make for one regex.
 */
const VERSION_SPEC_RE = /^[\w.^~<>=*+ |-]*$/;

export type WorkspaceDependencyOptions = {
  /** This process's workspaces root — every workspace and build dir sits under it. */
  sharedRoot: string;
  /** The baked toolchain's `node_modules`, or null when it can't be found. */
  toolchainModules: string | null;
  /**
   * Wall-clock budget for the whole reconciliation, across every package.
   * Defaults to {@link DEFAULT_INSTALL_BUDGET_MS}; the session-install path
   * passes {@link SESSION_INSTALL_BUDGET_MS}.
   */
  budgetMs?: number | undefined;
};

export type DependencyPlan = {
  /** `name → spec` for the packages to add to the shared manifest. */
  install: Record<string, string>;
  /** Named, per-entry reasons something declared was left out. Never silent. */
  skipped: string[];
};

/**
 * What of `manifest`'s runtime dependencies still needs installing.
 *
 * `isSatisfied` answers for every place a bare import can come from, and takes
 * the DECLARED SPEC as well as the name — see {@link ensureWorkspaceDependencies}
 * for why presence alone is not the question.
 *
 * A manifest that is not an object, or whose `dependencies` is not one, plans
 * nothing rather than throwing: the agent may be mid-edit, and npm reports a
 * broken manifest far better than a crash here would.
 */
export function planWorkspaceDependencies(
  manifest: unknown,
  isSatisfied: (name: string, spec: string) => boolean,
): DependencyPlan {
  const install: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [name, spec] of Object.entries(dependenciesOf(manifest))) {
    if (isSatisfied(name, String(spec))) continue;
    if (!PACKAGE_NAME_RE.test(name)) {
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
 * Install `dir`'s declared runtime dependencies when any are unsatisfied.
 *
 * **"Satisfied" is not "present", and the difference is a shipped bug.** The
 * shared root outlives the build dirs that read it, so a package installed for
 * one publish is still sitting there at the next — and a mere `existsSync`
 * therefore answered "already handled" for a workspace that had since CHANGED
 * the version it asks for. Measured: pin `date-fns` at 3.6.0, publish, bump the
 * manifest to 4.1.0, publish again — the second bundle still carried 3.6.0,
 * with no warning anywhere. So the shared root only counts when the spec it was
 * STAGED with is the spec now declared; that needs no semver matcher and is
 * exact, because the staged manifest is the one npm resolved.
 *
 * The other two sources answer on presence, deliberately. The toolchain is
 * checked FIRST and wins: the platform owns those versions, and re-installing
 * one for a spec change is the shadowing this module exists to avoid. The
 * workspace's own `node_modules` is whatever `add_dependency` reified from this
 * same manifest.
 *
 * Returns null when nothing needed doing or every install succeeded, and
 * otherwise a diagnostic naming what is unusable — prose for the coding agent,
 * which is the reader that can act on it. It is a WARNING rather than a thrown
 * error on purpose: a manifest can name a package no source file imports, and
 * failing a publish over one would be a regression against the build that used
 * to succeed by ignoring the manifest entirely.
 */
export async function ensureWorkspaceDependencies(
  dir: string,
  opts: WorkspaceDependencyOptions,
): Promise<string | null> {
  const manifest = await readJson(path.join(dir, "package.json"));
  if (manifest === null) return null;

  const { sharedRoot, toolchainModules } = opts;
  /** Plan against the tree as it is right now. Cheap: reads one small file. */
  const planNow = async (): Promise<DependencyPlan> => {
    const staged = dependenciesOf(await readJson(sharedManifestPath(sharedRoot)));
    return planWorkspaceDependencies(
      manifest,
      (name, spec) =>
        (toolchainModules !== null && existsSync(path.join(toolchainModules, name))) ||
        existsSync(path.join(dir, "node_modules", name)) ||
        (staged[name] === spec && existsSync(path.join(sharedRoot, "node_modules", name))),
    );
  };

  // The common case is that nothing needs installing, and it must not take the
  // lock: with an acquire deadline (below) a no-op call could otherwise FAIL on
  // a contended lock while having no work to do.
  const first = await planNow();
  const remembered = rememberFailures(first.install);
  if (Object.keys(first.install).length === 0) {
    return describeMissing(remembered, first.skipped) || null;
  }

  let failures: InstallFailure[];
  let skipped = first.skipped;
  try {
    ({ failures, skipped } = await withLock(
      installLock,
      sharedRoot,
      async () => {
        // Re-planned inside the lock: an overlapping build may have installed
        // exactly these while this one waited, and re-running npm for a tree
        // that already satisfies us is the whole cost this module avoids.
        const fresh = await planNow();
        return {
          failures: await installShared(sharedRoot, fresh.install, opts),
          skipped: fresh.skipped,
        };
      },
      { timeoutMs: LOCK_ACQUIRE_TIMEOUT_MS },
    ));
  } catch (err) {
    // Only the acquire can throw here — `installShared` reports per package.
    // Another caller is installing; say so rather than failing the build, and
    // let the next call re-plan against whatever they land.
    failures = Object.keys(first.install).map((name) => ({
      name,
      output: `another build is installing dependencies: ${errorMessage(err)}`,
    }));
  }

  return describeMissing([...remembered, ...failures], skipped) || null;
}

/**
 * The subset of `specs` this process has already tried and failed, dropped
 * from `specs` so they are not re-attempted. See {@link failedInstalls}.
 */
function rememberFailures(specs: Record<string, string>): InstallFailure[] {
  const now = Date.now();
  const out: InstallFailure[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const output = rememberedFailure(name, spec, now);
    if (output === undefined) continue;
    out.push({ name, output });
    delete specs[name];
  }
  return out;
}

/** The chat-facing diagnostic: what is unusable, why, and npm's own tail. */
function describeMissing(failures: InstallFailure[], skipped: string[]): string {
  const lines: string[] = [];
  if (failures.length > 0) {
    lines.push(
      `Could not install ${failures.map((f) => f.name).join(", ")} — declared in ` +
        "package.json, but not resolvable, so any import of them will fail to build. " +
        "Check the name and version, or remove the entry.",
      ...failures.map((f) => `${f.name}: ${f.output || "(npm produced no output)"}`),
    );
  }
  for (const note of skipped) lines.push(`Skipped ${note}`);
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
