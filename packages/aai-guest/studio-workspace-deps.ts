// Copyright 2026 the AAI authors. MIT license.
/**
 * Reify a workspace's OWN package.json — put the packages its `dependencies`
 * declare on disk before anything tries to build against them.
 *
 * A workspace manifest is not decoration: `ensureProjectShape` writes one, the
 * coding agent edits it (through `add_dependency` or by hand), and a project
 * pushed with `aai push` brings its own. But nothing ever reified it. The only
 * thing that put a package on disk was `add_dependency` running in that exact
 * directory, in that exact session — and a workspace directory does not survive
 * either boundary it has to cross:
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
 * **So: run `npm install` in the workspace.** That is the whole mechanism, and
 * it is only viable because the manifest declares nothing but the workspace's
 * own dependencies — see `WORKSPACE_DEPENDENCIES` in `studio-project-shape.ts`.
 * The platform's packages (the SDK, React, Tailwind, zod) resolve from the
 * toolchain `node_modules` above every workspace, and leaving them undeclared
 * is what keeps this cheap: measured, adding one small package costs **451ms
 * and 28 KB** this way against **25s and 156 MB** when the manifest also named
 * the platform's six, because npm reifies whatever manifest it reads.
 *
 * An earlier version of this file staged each missing package into a separate
 * shared manifest one directory up and ran npm once per package, to work around
 * that reification. It needed spec validation, per-package runs, un-staging,
 * failure memoization, per-process scoping and a shadow check — seven
 * mechanisms, all downstream of declaring six packages that did not need to be
 * declared. Do not reintroduce them without first checking whether the manifest
 * has grown platform-owned entries again.
 *
 * **`--omit=dev`.** `devDependencies` are the TOOLCHAIN (vite, typescript,
 * vitest, the `@types/*`), baked into the guest image. `ensureProjectShape`
 * writes none, but a project pushed from a laptop carries the scaffold's whole
 * block, and fetching it here would be a large download arriving back where we
 * started.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { createKeyedLock, isRecord, KeyedLockTimeoutError, withLock } from "@alexkroman1/aai/utils";
import { NPM_TIMEOUT_MS, runNpm } from "./studio-spawn.ts";
import { readWorkspaceManifest } from "./studio-workspace-fs.ts";

/**
 * The budget for the session-install path, which is the one with a caller
 * waiting on a deadline it did not choose: the host gives up at 30s
 * (`ADOPT_TIMEOUT_MS`) or 60s (`SESSION_INIT_TIMEOUT_MS`) in
 * `aai-studio-server`, and session-init runs on EVERY page open. Sized well
 * under the shorter of the two, so a slow registry costs a degraded install —
 * reported through the warning, which is already non-fatal — rather than a
 * failed session.
 */
export const SESSION_INSTALL_BUDGET_MS = 20_000;

/**
 * How long a caller waits for another install of the SAME directory before
 * giving up. Contention is rare (a turn is gated, and Publish builds in its own
 * directory), but a queue that cannot be refused is a queue that grows one
 * entry per page open, each waiting on work its own host already abandoned.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

/** One install at a time per directory — npm takes no lock of its own. */
const installLock = createKeyedLock();

export type WorkspaceDependencyOptions = {
  /** The baked toolchain's `node_modules`, or null when it can't be found. */
  toolchainModules: string | null;
  /**
   * Wall-clock budget for the install. Defaults to npm's own cap; the
   * session-install path passes {@link SESSION_INSTALL_BUDGET_MS}.
   */
  budgetMs?: number | undefined;
};

/** A manifest's `dependencies` as a plain record — `{}` for any other shape. */
function dependenciesOf(manifest: unknown): Record<string, string> {
  const declared = isRecord(manifest) ? manifest.dependencies : undefined;
  return isRecord(declared) ? (declared as Record<string, string>) : {};
}

/**
 * The declared runtime dependencies that nothing can resolve yet.
 *
 * Both places a bare import can come from are checked: the workspace's own
 * `node_modules` and the baked toolchain's, which sits above the workspace and
 * is found by Node's ordinary walk-up. A manifest that is not an object, or
 * whose `dependencies` is not one, reports nothing rather than throwing — the
 * agent may be mid-edit, and npm describes a broken manifest far better than a
 * crash here would.
 */
export function missingDependencies(
  manifest: unknown,
  isResolvable: (name: string) => boolean,
): string[] {
  return Object.keys(dependenciesOf(manifest)).filter((name) => !isResolvable(name));
}

/**
 * Install `dir`'s declared runtime dependencies when any are missing.
 *
 * Returns null when there was nothing to do or the install succeeded, and
 * otherwise a diagnostic naming what is still unresolvable — prose for the
 * coding agent, which is the reader that can act on it. It is a WARNING rather
 * than a thrown error on purpose: a manifest can name a package no source file
 * imports, and failing a publish over one would be a regression against the
 * build that used to succeed by ignoring the manifest entirely.
 *
 * The check is presence, not version satisfaction. That is npm's own rule for a
 * tree it already reified — `npm install` is what reconciles a changed spec,
 * and every path that changes one (`add_dependency`, `update_dependencies`, a
 * hand edit followed by the next build) runs through here.
 */
export async function ensureWorkspaceDependencies(
  dir: string,
  opts: WorkspaceDependencyOptions,
): Promise<string | null> {
  // No manifest, or mid-edit — nothing to reify.
  const manifest = await readWorkspaceManifest(dir);
  if (manifest === null) return null;

  const { toolchainModules } = opts;
  const isResolvable = (name: string): boolean =>
    existsSync(path.join(dir, "node_modules", name)) ||
    (toolchainModules !== null && existsSync(path.join(toolchainModules, name)));

  // The common case is that nothing is missing, and it must not take the lock:
  // with an acquire deadline, a no-op call could otherwise fail on contention
  // while having no work to do.
  if (missingDependencies(manifest, isResolvable).length === 0) return null;

  let output: string;
  try {
    output = await withLock(
      installLock,
      dir,
      async () => {
        // Re-checked inside the lock: an overlapping build may have installed
        // exactly these while this one waited.
        if (missingDependencies(manifest, isResolvable).length === 0) return "";
        const result = await runNpm(
          dir,
          ["install", "--omit=dev"],
          opts.budgetMs ?? NPM_TIMEOUT_MS,
        );
        return result.signal
          ? `killed by ${result.signal} after ${opts.budgetMs ?? NPM_TIMEOUT_MS}ms`
          : result.stdout.trim();
      },
      { timeoutMs: LOCK_ACQUIRE_TIMEOUT_MS },
    );
  } catch (err) {
    // Only the acquire can throw — the run itself resolves either way.
    output =
      err instanceof KeyedLockTimeoutError
        ? "another build is installing this workspace's dependencies"
        : errorMessage(err);
  }

  // npm's exit code is not the question — whether the imports resolve now is.
  const stillMissing = missingDependencies(manifest, isResolvable);
  if (stillMissing.length === 0) return null;
  return [
    `Could not install ${stillMissing.join(", ")} — declared in package.json, but not ` +
      "resolvable, so any import of them will fail to build. Check the name and " +
      "version, or remove the entry.",
    output || "(npm produced no output)",
  ].join("\n");
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
