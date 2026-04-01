/**
 * Starts a local Verdaccio npm registry, publishes workspace packages to it,
 * and configures the environment so npm/pnpm/yarn resolve from it.
 *
 * Follows the two-phase pattern from Cloudflare's workers-sdk:
 *   Phase 1: Start with no uplinks → publish local packages (avoids "already exists" errors)
 *   Phase 2: Restart with uplinks → install resolves missing deps from public npm
 */
import { type ChildProcess, execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MockRegistry {
  /** Local registry URL (http://localhost:<port>) */
  registryUrl: string;
  /** Environment variables to set for child processes using this registry */
  env: Record<string, string>;
  /** Stop the registry and clean up */
  stop: () => Promise<void>;
}

function writeConfig(configPath: string, port: number, withUplinks: boolean): void {
  const yaml = `
storage: ./storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  "**":
    access: $all
    publish: $all
    ${withUplinks ? "proxy: npmjs" : ""}
log:
  type: stdout
  format: pretty
  level: error
listen: localhost:${port}
`.trimStart();
  fs.writeFileSync(configPath, yaml);
}

function startServer(configPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const verdaccioEntry = require.resolve("verdaccio/bin/verdaccio");
    const child = fork(verdaccioEntry, ["-c", configPath], {
      silent: true,
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Verdaccio failed to start within 30s"));
    }, 30_000);

    child.on("message", (msg: { verdaccio_started: boolean }) => {
      if (msg.verdaccio_started) {
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error(`Verdaccio exited with code ${code}`));
    });
  });
}

async function killTree(pid: number): Promise<void> {
  // biome-ignore lint/correctness/noUndeclaredDependencies: tree-kill is a devDependency of the root workspace
  const treeKill = (await import("tree-kill")).default;
  return new Promise((resolve, reject) => {
    treeKill(pid, (err?: Error) => (err ? reject(err) : resolve()));
  });
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
  // biome-ignore lint/correctness/noUndeclaredDependencies: get-port is a devDependency of the root workspace
  const getPort = (await import("get-port")).default;
  const port = await getPort();
  const registryUrl = `http://localhost:${port}`;

  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-mock-registry-"));
  const configPath = path.join(registryDir, "config.yaml");
  fs.mkdirSync(path.join(registryDir, "storage"), { recursive: true });

  // Phase 1: No uplinks — publish local packages without "already exists" errors
  writeConfig(configPath, port, false);
  let child = await startServer(configPath);

  const publishEnv = {
    ...process.env,
    npm_config_registry: registryUrl,
    npm_config_userconfig: path.join(registryDir, ".npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(registryDir, ".npmrc"),
  };

  // Write .npmrc with dummy auth token
  fs.writeFileSync(
    path.join(registryDir, ".npmrc"),
    `registry=${registryUrl}\n//localhost:${port}/:_authToken=test-token\n`,
  );

  // Build and publish each package
  for (const pkgName of packageNames) {
    const pkgPath = path.join(packagesDir, pkgName);
    execFileSync("pnpm", ["run", "build"], { cwd: pkgPath, stdio: "inherit" });
    execFileSync("pnpm", ["publish", "--no-git-checks", "--registry", registryUrl], {
      cwd: pkgPath,
      stdio: "inherit",
      env: publishEnv,
    });
  }

  // Phase 2: Restart with uplinks — install can resolve transitive deps from public npm
  // biome-ignore lint/style/noNonNullAssertion: pid is always set after fork()
  await killTree(child.pid!);
  writeConfig(configPath, port, true);
  child = await startServer(configPath);

  const registryEnv: Record<string, string> = {
    npm_config_registry: registryUrl,
    npm_config_userconfig: path.join(registryDir, ".npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(registryDir, ".npmrc"),
  };

  return {
    registryUrl,
    env: registryEnv,
    stop: async () => {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally swallowing cleanup errors
      if (child.pid) await killTree(child.pid).catch(() => {});
      fs.rmSync(registryDir, { recursive: true, force: true });
    },
  };
}
