// Copyright 2026 the AAI authors. MIT license.
/**
 * The SHARED ROOT: `.workspaces/<pid>/`, the one `node_modules` every session
 * workspace and Publish build dir under it resolves through, and the staged
 * `package.json` npm reifies to fill it.
 *
 * Split from `studio-workspace-deps.ts`, which decides WHAT a workspace still
 * needs; this decides how a package gets there. Everything here is about the
 * shared tree — where its manifest lives, staging one package into it, the
 * budget a run may spend, what is remembered about a failure, and the one
 * hazard a shared tree carries (a hoisted package shadowing the toolchain).
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { NPM_TIMEOUT_MS, runNpm } from "./studio-spawn.ts";

/**
 * Default wall-clock budget for the WHOLE reconciliation, not per package.
 *
 * Per-package was the bug: `installShared` runs one npm per missing package,
 * each capped at `NPM_TIMEOUT_MS`, so three unreachable packages could block a
 * caller for ~330s. Publish can afford that (its own cap is 300s and the user
 * is watching a publish), but session-init cannot — see
 * {@link SESSION_INSTALL_BUDGET_MS}.
 */
export const DEFAULT_INSTALL_BUDGET_MS = NPM_TIMEOUT_MS;

/**
 * The budget for the session-install path, which is the one with a caller
 * waiting on a deadline it did not choose: the host gives up at 30s
 * (`ADOPT_TIMEOUT_MS`) or 60s (`SESSION_INIT_TIMEOUT_MS`) in
 * `aai-studio-server`, and session-init runs on EVERY page open. Sized well
 * under the shorter of the two so a slow registry costs a degraded install
 * (reported through the warning, which is already non-fatal) rather than a
 * failed session — and so the next page open is not queueing behind work its
 * own caller has already abandoned.
 */
export const SESSION_INSTALL_BUDGET_MS = 20_000;

/**
 * How long a caller waits for another to finish installing before giving up.
 *
 * Without this a second page open queues behind an install its own host has
 * already timed out on, and the queue grows one entry per open. Failing the
 * acquire is the better answer: the workspace is usable, the warning says what
 * is missing, and the next call re-plans against whatever the winner installed.
 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Specs already tried and failed in this process, with npm's explanation.
 *
 * Un-staging a failure is required (a bad entry left in the shared manifest
 * would break every later install), but it also erases the only record that the
 * spec was tried — so without this the same doomed npm run is re-spawned on
 * every `test_agent`, which is exactly what the coding agent loops on while
 * repairing a build. Keyed by `name@spec`, so editing the version retries
 * immediately; entries expire so a transient registry outage self-heals.
 */
const failedInstalls = new Map<string, { output: string; at: number }>();

/** How long a failed spec is remembered. Short: the repair loop iterates in
 * seconds, and a registry blip must not be cached for the sandbox's life. */
const FAILED_INSTALL_TTL_MS = 60_000;

/** The remembered failure for `name@spec`, if it has not expired. */
export function rememberedFailure(name: string, spec: string, now: number): string | undefined {
  const hit = failedInstalls.get(`${name}@${spec}`);
  if (hit === undefined) return;
  if (now - hit.at <= FAILED_INSTALL_TTL_MS) return hit.output;
  failedInstalls.delete(`${name}@${spec}`);
}

/** Test seam: forget every remembered failure. */
export function resetFailedInstalls(): void {
  failedInstalls.clear();
}
/**
 * Where the shared install lives, and the two files it owns. Named off the
 * workspaces root the caller passes in, so this module stays clear of
 * `studio-build.ts`, which calls it.
 */
export const sharedManifestPath = (sharedRoot: string): string =>
  path.join(sharedRoot, "package.json");
/** Read and parse a JSON file, or null when it is missing/unparseable. */
export async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

/** A manifest's `dependencies` as a plain record — `{}` for any other shape. */
export function dependenciesOf(manifest: unknown): Record<string, string> {
  const declared = (manifest as { dependencies?: unknown } | null)?.dependencies;
  return declared && typeof declared === "object" ? (declared as Record<string, string>) : {};
}

/** One package the install could not satisfy, with npm's own explanation. */
export type InstallFailure = { name: string; output: string };
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
export async function installShared(
  sharedRoot: string,
  specs: Record<string, string>,
  opts: { toolchainModules: string | null; budgetMs?: number | undefined },
): Promise<InstallFailure[]> {
  const budgetMs = opts.budgetMs ?? DEFAULT_INSTALL_BUDGET_MS;
  const failures: InstallFailure[] = [];
  const deadline = Date.now() + budgetMs;
  for (const [name, spec] of Object.entries(specs)) {
    // The budget is for the WHOLE reconciliation, so each run gets what is
    // left of it — and once it is spent the rest are reported unattempted
    // rather than run past a deadline the caller has already given up on.
    const remaining = deadline - Date.now();
    const { ok, output } =
      remaining <= 0
        ? { ok: false, output: `not attempted — the ${budgetMs}ms install budget was spent` }
        : await installOne(sharedRoot, name, spec, remaining);
    if (ok) continue;
    failures.push({ name, output });
    failedInstalls.set(`${name}@${spec}`, { output, at: Date.now() });
    await stage(sharedRoot, name, null);
  }
  if (failures.length < Object.keys(specs).length) {
    warnOnShadowedToolchain(sharedRoot, opts.toolchainModules);
  }
  return failures;
}

/**
 * Log any package the install HOISTED into the shared root that the toolchain
 * already provides.
 *
 * `--omit=peer` closes one instance of this — a declared peer would hoist and
 * shadow — but ordinary transitive dependencies use the same mechanism and get
 * no equivalent: a user package depending on `react` or `zod` lands it here,
 * ABOVE the toolchain on every workspace's resolution path, so the client
 * bundle silently builds against a registry copy instead of the baked one.
 * That is the exact drift `reconcileWorkspacePins` exists to prevent.
 *
 * This checks the MECHANISM rather than one of its causes, which is what makes
 * the module's "no shadowing" claim checkable instead of asserted. It logs
 * rather than warns through {@link describeMissing}: a shadowed package does
 * not fail the build (that is the problem with it), so the chat-facing channel
 * — which only surfaces on failure — would never show it. This is an operator
 * signal, and the tenant cannot act on it anyway.
 */
function warnOnShadowedToolchain(sharedRoot: string, toolchainModules: string | null): void {
  if (toolchainModules === null) return;
  const shadowed = topLevelPackages(path.join(sharedRoot, "node_modules")).filter((name) =>
    existsSync(path.join(toolchainModules, name)),
  );
  if (shadowed.length > 0) {
    console.error(
      `studio workspace dependencies: ${shadowed.join(", ")} hoisted into the shared root ` +
        "and now shadow the baked toolchain's copy for every workspace under it",
    );
  }
}

/** Top-level package names in a node_modules tree, scopes expanded. */
function topLevelPackages(modulesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.startsWith("@")) return entry.startsWith(".") ? [] : [entry];
    try {
      return readdirSync(path.join(modulesDir, entry)).map((child) => `${entry}/${child}`);
    } catch {
      return [];
    }
  });
}

/**
 * Stage one package into the shared manifest and reify it.
 *
 * Success is npm's **exit code**, not "is the directory there now". Those came
 * apart once the spec started mattering: on a version change the directory is
 * already present carrying the OLD version, so presence proves nothing, while
 * exit 0 means npm satisfied the range it was given. The cost is that a
 * package whose postinstall script fails is reported even though its files
 * landed — a false alarm on a failing build, against silently shipping a
 * version the manifest does not ask for.
 */
async function installOne(
  sharedRoot: string,
  name: string,
  spec: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    await stage(sharedRoot, name, spec);
  } catch (err) {
    return { ok: false, output: `could not stage the install manifest: ${errorMessage(err)}` };
  }
  try {
    // `--omit=peer` for the same reason as `--omit=dev`: a peer dependency
    // says "the host provides this", and here the host is the baked toolchain.
    // Installed, a package's `react` peer would hoist into the shared root and
    // SHADOW the toolchain's for every workspace under it, silently changing
    // the React the client bundle is built against. Left out, a peer the
    // toolchain really lacks fails the build by name, which the agent can
    // answer with `add_dependency`.
    const result = await runNpm(sharedRoot, ["install", "--omit=dev", "--omit=peer"], timeoutMs);
    return result.signal
      ? { ok: false, output: `killed by ${result.signal} after ${timeoutMs}ms` }
      : { ok: result.exitCode === 0, output: result.stdout.trim() };
  } catch (err) {
    return { ok: false, output: errorMessage(err) };
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
export async function stage(sharedRoot: string, name: string, spec: string | null): Promise<void> {
  const manifestPath = sharedManifestPath(sharedRoot);
  await mkdir(sharedRoot, { recursive: true });
  const dependencies = dependenciesOf(await readJson(manifestPath));
  if (spec === null) delete dependencies[name];
  else dependencies[name] = spec;
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
