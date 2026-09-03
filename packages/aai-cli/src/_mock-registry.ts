/**
 * Starts a local Verdaccio npm registry, publishes workspace packages to it,
 * and configures the environment so npm/pnpm/yarn resolve from it.
 *
 * Workspace packages are never proxied to the real npm registry —
 * they are always served from verdaccio's local storage. Consumer projects
 * use a fresh pnpm store-dir to avoid stale content-addressable cache hits.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@alexkroman1/aai/utils";
import { execaNode, execaSync, type ResultPromise } from "execa";
import pTimeout from "p-timeout";
import { binFromPackageJson, errorMessage } from "./_utils.ts";

// This file is ESM ("type": "module") — a bare `require.resolve` only worked
// because vitest's runtime injects `require`; importing this from a plain
// Node ESM context (a debug script reproducing an e2e flake) threw
// `ReferenceError: require is not defined`.
const require = createRequire(import.meta.url);

export interface MockRegistry {
  /** Local registry URL (http://localhost:<port>) */
  registryUrl: string;
  /** The unique version string used for published workspace packages */
  testVersion: string;
  /** Environment variables to set for child processes using this registry */
  env: Record<string, string>;
  /** Stop the registry and clean up */
  stop: () => Promise<void>;
}

function writeConfig(configPath: string, port: number): void {
  // Workspace packages are local-only.
  // Everything else proxies to npmjs for third-party deps.
  //
  // Uplink hardening against a verdaccio footgun: its defaults mark an
  // uplink DEAD after 2 failed requests (max_fails) for 5 minutes
  // (fail_timeout), answering every proxied fetch with an instant 404 while
  // dead — so two dropped connections would poison the rest of the suite
  // with ERR_PNPM_FETCH_404 on ordinary packages. Raising max_fails and
  // shrinking fail_timeout makes a transient failure cost one retried
  // request instead of the run; the keep-alive agent with capped sockets
  // avoids connection bursts against the upstream. (The 404s actually seen
  // under `pnpm check` had a different cause — turbo's strict env mode
  // stripping the proxy variables; see globalPassThroughEnv in turbo.json.)
  const yaml = `
storage: ./storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    timeout: 60s
    max_fails: 100
    fail_timeout: 1s
    agent_options:
      keepAlive: true
      maxSockets: 8
      maxFreeSockets: 4
packages:
  "@alexkroman1/*":
    access: $all
    publish: $all
  "@*/*":
    access: $all
    proxy: npmjs
  "**":
    access: $all
    publish: $all
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: error
listen: localhost:${port}
`.trimStart();
  fs.writeFileSync(configPath, yaml);
}

type VerdaccioProcess = ResultPromise<{ ipc: true; stdout: "ignore"; stderr: "ignore" }>;

/**
 * Absolute path to verdaccio's CLI entry, resolved through its `bin` field.
 *
 * NOT `require.resolve("verdaccio/bin/verdaccio")`. That is a subpath, and
 * verdaccio 6.9 narrowed its `exports` map to `.` and `./package.json` — so
 * the subpath stopped resolving (`ERR_PACKAGE_PATH_NOT_EXPORTED`) even though
 * `bin` still points at exactly that file. It fails at IMPORT time, taking the
 * whole e2e suite down as a failed SUITE with all 19 tests skipped, which is a
 * shape worth recognising: `pnpm check:local` never runs this tier, so only the
 * pre-push hook or CI sees it.
 *
 * `./package.json` is exported (and a package that stops exporting it cannot be
 * resolved by anything), so reading `bin` from there and joining it to the
 * package root asks the package where its CLI is instead of guessing.
 */
function resolveVerdaccioBin(): string {
  const manifestPath = require.resolve("verdaccio/package.json");
  // The same read the CLI does for the project's `tsc` and `vitest` bins —
  // both spellings of `bin` (a string, or a map) handled in one place.
  const entry = binFromPackageJson(manifestPath, "verdaccio");
  if (entry === undefined) {
    throw new Error("mock registry: verdaccio's package.json declares no `bin` entry to run.");
  }
  return entry;
}

// The subprocess is returned wrapped in an object: a ResultPromise is itself
// a thenable, so returning it bare would make the caller's `await` unwrap it
// into a final Result instead of the live process handle.
async function startServer(configPath: string): Promise<{ server: VerdaccioProcess }> {
  const verdaccioEntry = resolveVerdaccioBin();
  const subprocess = execaNode(verdaccioEntry, ["-c", configPath], {
    ipc: true,
    stdout: "ignore",
    stderr: "ignore",
  });

  // getOneMessage rejects on its own if the process errors or exits early,
  // so only the startup deadline needs wiring up by hand. execa's `timeout`
  // option is not usable here — it would kill the long-running server.
  const started = subprocess.getOneMessage({
    filter: (msg) => isRecord(msg) && "verdaccio_started" in msg,
  });
  try {
    await pTimeout(started, {
      milliseconds: 30_000,
      message: new Error("Verdaccio failed to start within 30s"),
    });
  } catch (err) {
    subprocess.kill();
    throw err;
  }
  return { server: subprocess };
}

/**
 * Start a mock npm registry, build and publish workspace packages to it.
 *
 * @param packagesDir - Path to the `packages/` directory in the monorepo
 * @param packageNames - Directory names under `packages/` to publish (e.g. ["aai", "aai-ui", "aai-cli"])
 */
export async function startMockRegistry(
  packagesDir: string,
  packageNames: string[],
): Promise<MockRegistry> {
  const getPort = (await import("get-port")).default;
  const port = await getPort();
  const registryUrl = `http://localhost:${port}`;

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-mock-registry-"));
  const configPath = path.join(registryDir, "config.yaml");
  fs.mkdirSync(path.join(registryDir, "storage"), { recursive: true });

  const registryEnv: Record<string, string> = {
    npm_config_registry: registryUrl,
    npm_config_userconfig: path.join(registryDir, ".npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(registryDir, ".npmrc"),
  };

  // Write .npmrc with dummy auth token
  fs.writeFileSync(
    path.join(registryDir, ".npmrc"),
    `registry=${registryUrl}\n//localhost:${port}/:_authToken=test-token\n`,
  );

  // Use a unique version to avoid pnpm store cache collisions — the global
  // content-addressable store caches tarballs by name+version, so publishing
  // new content under the same version (e.g. 0.12.3) silently serves stale bytes.
  const testVersion = `0.0.0-e2e.${Date.now()}`;

  // Start verdaccio, then build and publish each workspace package
  writeConfig(configPath, port);
  const { server: child } = await startServer(configPath);

  // Terminate (SIGTERM, escalating to SIGKILL via execa's default
  // forceKillAfterDelay) and await exit, swallowing the "killed" rejection.
  const killServer = async () => {
    child.kill();
    await child.catch(() => undefined);
  };

  try {
    publishPackages(packagesDir, packageNames, testVersion, registryUrl, registryEnv);
  } catch (err) {
    // A failed build/publish (or unparseable package.json) must not leave
    // the verdaccio child running across the rest of the test run.
    await killServer();
    throw err;
  }

  return {
    registryUrl,
    testVersion,
    env: registryEnv,
    stop: async () => {
      await killServer();
      fs.rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

/** Parse a package.json, rewriting version + workspace: deps to `testVersion`. */
function patchPkgJson(originalPkg: string, pkgJsonPath: string, testVersion: string): string {
  let pkg: ReturnType<typeof JSON.parse>;
  try {
    pkg = JSON.parse(originalPkg);
  } catch (err) {
    throw new Error(`Invalid JSON in ${pkgJsonPath}: ${errorMessage(err)}`, { cause: err });
  }
  pkg.version = testVersion;
  delete pkg.private; // Allow publishing private packages to mock registry
  for (const depField of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!pkg[depField]) continue;
    for (const [dep, ver] of Object.entries(pkg[depField])) {
      if (typeof ver === "string" && ver.startsWith("workspace:")) {
        pkg[depField][dep] = testVersion;
      }
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Crash-recovery sidecar for the in-place package.json patch below: the
 * pristine file is copied to `package.json.e2e-backup` before patching, and
 * an interrupted run (SIGKILL/OOM mid-publish, when `finally` never runs) is
 * healed on the next run by restoring from the backup before re-patching.
 */
function backupPath(pkgJsonPath: string): string {
  return `${pkgJsonPath}.e2e-backup`;
}

/** Restore package.json from a stale backup left by a killed run, if any. */
function recoverFromStaleBackup(pkgJsonPath: string): void {
  const backup = backupPath(pkgJsonPath);
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, pkgJsonPath);
    fs.rmSync(backup, { force: true });
  }
}

function publishPackages(
  packagesDir: string,
  packageNames: string[],
  testVersion: string,
  registryUrl: string,
  registryEnv: Record<string, string>,
): void {
  for (const pkgName of packageNames) {
    const pkgPath = path.join(packagesDir, pkgName);
    const pkgJsonPath = path.join(pkgPath, "package.json");
    recoverFromStaleBackup(pkgJsonPath);
    const originalPkg = fs.readFileSync(pkgJsonPath, "utf-8");

    // Temporarily set a unique version so pnpm never hits a stale cache.
    // The backup file survives a hard kill; `finally` handles the normal path.
    fs.writeFileSync(backupPath(pkgJsonPath), originalPkg);
    fs.writeFileSync(pkgJsonPath, patchPkgJson(originalPkg, pkgJsonPath, testVersion));

    try {
      execaSync("pnpm", ["run", "build"], { cwd: pkgPath, stdio: "inherit" });
      execaSync("pnpm", ["publish", "--no-git-checks", "--tag", "e2e", "--registry", registryUrl], {
        cwd: pkgPath,
        stdio: "inherit",
        // execa extends process.env by default, so only the overrides are passed.
        env: registryEnv,
      });
    } finally {
      fs.writeFileSync(pkgJsonPath, originalPkg);
      fs.rmSync(backupPath(pkgJsonPath), { force: true });
    }
  }
}
