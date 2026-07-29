/**
 * Starts a local Verdaccio npm registry, publishes workspace packages to it,
 * and configures the environment so npm/pnpm/yarn resolve from it.
 *
 * Workspace packages are never proxied to the real npm registry —
 * they are always served from verdaccio's local storage. Consumer projects
 * use a fresh pnpm store-dir to avoid stale content-addressable cache hits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execaNode, execaSync, type ResultPromise } from "execa";

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
  const yaml = `
storage: ./storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
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

// The subprocess is returned wrapped in an object: a ResultPromise is itself
// a thenable, so returning it bare would make the caller's `await` unwrap it
// into a final Result instead of the live process handle.
async function startServer(configPath: string): Promise<{ server: VerdaccioProcess }> {
  const verdaccioEntry = require.resolve("verdaccio/bin/verdaccio");
  const subprocess = execaNode(verdaccioEntry, ["-c", configPath], {
    ipc: true,
    stdout: "ignore",
    stderr: "ignore",
  });

  // getOneMessage rejects on its own if the process errors or exits early,
  // so only the startup deadline needs wiring up by hand. execa's `timeout`
  // option is not usable here — it would kill the long-running server.
  const started = subprocess.getOneMessage({
    filter: (msg) => typeof msg === "object" && msg !== null && "verdaccio_started" in msg,
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Verdaccio failed to start within 30s")), 30_000);
  });
  try {
    await Promise.race([started, deadline]);
  } catch (err) {
    subprocess.kill();
    throw err;
  } finally {
    clearTimeout(timer);
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

  for (const pkgName of packageNames) {
    const pkgPath = path.join(packagesDir, pkgName);
    const pkgJsonPath = path.join(pkgPath, "package.json");
    const originalPkg = fs.readFileSync(pkgJsonPath, "utf-8");

    // Temporarily set a unique version so pnpm never hits a stale cache
    const pkg = JSON.parse(originalPkg);
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
    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

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
    }
  }

  return {
    registryUrl,
    testVersion,
    env: registryEnv,
    stop: async () => {
      // Terminate (SIGTERM, escalating to SIGKILL via execa's default
      // forceKillAfterDelay) and await exit, swallowing the "killed" rejection.
      child.kill();
      await child.catch(() => undefined);
      fs.rmSync(registryDir, { recursive: true, force: true });
    },
  };
}
