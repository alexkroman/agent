// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared helpers for the e2e test suites (e2e*.test.ts): CLI build, mock
 * registry setup, dependency installation, and process/server utilities.
 * Each e2e suite performs its own setup/teardown using these helpers.
 */
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execaSync } from "execa";
import { ofetch } from "ofetch";
import type { MockRegistry } from "./_mock-registry.ts";

export const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
export const packagesDir = path.resolve(dir, "..");

export const pm = (process.env.AAI_TEST_PM ?? "pnpm") as "pnpm" | "npm" | "yarn";

/**
 * Throwaway global-config dir for every CLI the e2e suites spawn, created
 * once per run so a scenario's later steps still see the key an earlier step
 * saved.
 *
 * The child is a real process with VITEST cleared (it has to be, or the CLI
 * skips `main()`), so neither `_test-setup.ts` nor `getConfigDir`'s
 * under-vitest fallback can protect it — this env var is the only thing that
 * can. Without it, each `--server http://127.0.0.1:<port>` an e2e run passes
 * is written to the developer's REAL config as a permanently approved origin,
 * and an approved loopback origin is precisely what lets a cloned repo's
 * `.aai/project.json` collect the developer's API key without a prompt.
 */
let _e2eConfigDir: string | undefined;
function e2eConfigDir(): string {
  _e2eConfigDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-config-"));
  return _e2eConfigDir;
}

export function aaiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST: undefined, // CLI skips main() when VITEST=true
    INIT_CWD: undefined, // resolveCwd() prefers INIT_CWD over process.cwd()
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    AAI_NO_DEV: "1",
    AAI_CONFIG_DIR: e2eConfigDir(),
    // Deliberately no AAI_TEMPLATES_DIR: the override pinned every e2e run to
    // the workspace's template sources, so the resolution order `init` really
    // ships (monorepo, then the copy bundled into dist/) was never exercised.
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "test",
    npm_config_ignore_scripts: "true", // avoid postinstall hooks in linked pkgs
  };
}

export function aai(aaiBin: string, args: string[], cwd: string, timeoutMs = 120_000): void {
  execaSync(process.execPath, [aaiBin, ...args], {
    cwd,
    extendEnv: false, // aaiEnv() is already the full, curated environment
    env: aaiEnv(),
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

/**
 * Build the CLI and return the path to the built binary.
 *
 * Runs the package's own `build` script rather than bare `tsdown`, because
 * the build is two steps now: tsdown, then `bundle-templates.mjs` copying the
 * templates into `dist/`. Calling the bundler directly produced a `dist/`
 * that no published tarball ever looks like — one with no templates in it.
 */
export function buildCli(): string {
  execaSync("pnpm", ["run", "build"], { cwd: dir, stdio: "inherit" });
  const mjs = path.resolve(dir, "dist/cli.mjs");
  const js = path.resolve(dir, "dist/cli.js");
  return fs.existsSync(mjs) ? mjs : js;
}

/**
 * Copy a built `dist/` somewhere with no pnpm-workspace.yaml above it, so the
 * CLI resolves templates the way an npm-installed copy does.
 *
 * `getMonorepoRoot()` keys off the *module's* location, so a build run from
 * `packages/aai-cli/dist` always finds the workspace root and takes the
 * monorepo branch — no test running in-tree can reach the bundled branch,
 * which is the only one real users hit.
 */
export function detachedCli(aaiBin: string, into: string): string {
  const distDir = path.dirname(aaiBin);
  fs.cpSync(distDir, path.join(into, "dist"), { recursive: true });
  // The CLI's runtime deps stay external (`deps: { neverBundle }`), so the
  // detached copy still needs a node_modules to resolve them from.
  fs.symlinkSync(path.resolve(dir, "node_modules"), path.join(into, "node_modules"), "dir");
  return path.join(into, "dist", path.basename(aaiBin));
}

/**
 * Start a mock npm registry and publish workspace packages to it.
 * Packages are built + published inside startMockRegistry, so consumers
 * (npm/pnpm/yarn install) resolve them exactly as they would from the real registry.
 */
export async function startRegistry(): Promise<MockRegistry> {
  const { startMockRegistry } = await import("./_mock-registry.ts");
  return startMockRegistry(packagesDir, ["aai", "aai-ui", "aai-cli"]);
}

/** Poll a health endpoint, capturing child stderr for diagnostics on timeout. */
export async function waitForHealth(
  url: string,
  child?: ChildProcess,
  timeoutMs = 30_000,
): Promise<void> {
  let stderr = "";
  child?.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const retryDelay = 500;
  try {
    await ofetch.raw(url, { retry: Math.ceil(timeoutMs / retryDelay), retryDelay });
  } catch (err) {
    throw new Error(`Timed out waiting for ${url}${stderr ? `\nServer stderr:\n${stderr}` : ""}`, {
      cause: err,
    });
  }
}

/** Wait for a child process to exit (for clean teardown). */
export async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    /* timed out — teardown proceeds anyway (matches previous behavior) */
  }
}

/** Install dependencies using the mock registry. */
export function installDeps(registry: MockRegistry, projectDir: string): void {
  const env = { ...aaiEnv(), ...registry.env };

  // Rewrite workspace dep versions to match the unique testVersion
  // published to the mock registry (avoids pnpm store cache collisions).
  const pkgJsonPath = path.join(projectDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  for (const depField of ["dependencies", "devDependencies"] as const) {
    if (!pkgJson[depField]) continue;
    for (const dep of Object.keys(pkgJson[depField])) {
      if (
        dep === "@alexkroman1/aai" ||
        dep === "@alexkroman1/aai-ui" ||
        dep === "@alexkroman1/aai-cli"
      ) {
        pkgJson[depField][dep] = registry.testVersion;
      }
    }
  }
  // Remove packageManager to avoid corepack version mismatches in tests
  delete pkgJson.packageManager;
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  // Write .npmrc in the project directory so pnpm reliably uses the mock
  // registry even when running under turbo (env-only config can be overridden
  // by ancestor .npmrc files discovered during directory traversal).
  const npmrcPath = path.join(projectDir, ".npmrc");
  const registryHost = new URL(registry.registryUrl).host;
  fs.writeFileSync(
    npmrcPath,
    `registry=${registry.registryUrl}\n//${registryHost}/:_authToken=test-token\n`,
  );

  // Corepack downloads pnpm 11.x for this scratch project (no packageManager
  // field). pnpm 11 enabled `minimumReleaseAge` by default with a 1-day cutoff,
  // which rejects any transitive dep published in the last 24h — flakes the
  // suite against fresh upstream releases. Disable via env var (most reliable
  // override; .npmrc is sometimes ignored when corepack-loaded).
  // CI=true lets pnpm purge a node_modules left by `aai init`'s own install
  // (which targets the real registry) without a TTY confirmation prompt —
  // otherwise the registry switch dies with
  // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY on machines where that inner
  // install succeeded.
  // FETCH_RETRIES: with the uplink no longer converting transient upstream
  // failures into definitive 404s (see _mock-registry.ts), pnpm's own retry
  // machinery can actually absorb a dropped connection under parallel load.
  const installEnv = {
    ...env,
    NPM_CONFIG_MINIMUM_RELEASE_AGE: "0",
    NPM_CONFIG_FETCH_RETRIES: "5",
    CI: "true",
  };

  // Output is CAPTURED (not inherited) so an install failure carries the
  // package manager's own error text on the thrown ExecaSyncError — the e2e
  // suite classifies that text to decide "registry proxy flake → skip"
  // versus "our published packages are broken → fail". With stdio:
  // "inherit" the error message was just the command line, unclassifiable.
  if (pm === "npm") {
    execaSync("npm", ["install"], { cwd: projectDir, extendEnv: false, env });
  } else if (pm === "yarn") {
    execaSync("yarn", ["install", "--no-lockfile"], {
      cwd: projectDir,
      extendEnv: false,
      env,
    });
  } else {
    execaSync(
      "pnpm",
      [
        "install",
        "--no-frozen-lockfile",
        "--no-strict-peer-dependencies",
        "--config.minimumReleaseAge=0",
      ],
      { cwd: projectDir, extendEnv: false, env: installEnv },
    );
  }
}
