// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared helpers for the e2e test suites (e2e*.test.ts): CLI build, mock
 * registry setup, dependency installation, and process/server utilities.
 * Each e2e suite performs its own setup/teardown using these helpers.
 */
import { type ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MockRegistry } from "./_mock-registry.ts";

export const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
export const packagesDir = path.resolve(dir, "..");

export const pm = (process.env.AAI_TEST_PM ?? "pnpm") as "pnpm" | "npm" | "yarn";

export function aaiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST: undefined, // CLI skips main() when VITEST=true
    INIT_CWD: undefined, // resolveCwd() prefers INIT_CWD over process.cwd()
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    AAI_NO_DEV: "1",
    AAI_TEMPLATES_DIR: path.resolve(dir, "../aai-templates"),
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "test",
    npm_config_ignore_scripts: "true", // avoid postinstall hooks in linked pkgs
  };
}

export function aai(aaiBin: string, args: string[], cwd: string, timeoutMs = 120_000): void {
  execFileSync(process.execPath, [aaiBin, ...args], {
    cwd,
    env: aaiEnv(),
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

/** Build the CLI with tsdown and return the path to the built binary. */
export function buildCli(): string {
  execFileSync("npx", ["tsdown"], { cwd: dir, stdio: "inherit" });
  const mjs = path.resolve(dir, "dist/cli.mjs");
  const js = path.resolve(dir, "dist/cli.js");
  return fs.existsSync(mjs) ? mjs : js;
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}${stderr ? `\nServer stderr:\n${stderr}` : ""}`);
}

/** Wait for a child process to exit (for clean teardown). */
export function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  const installEnv = { ...env, NPM_CONFIG_MINIMUM_RELEASE_AGE: "0" };

  if (pm === "npm") {
    execFileSync("npm", ["install"], { cwd: projectDir, stdio: "inherit", env });
  } else if (pm === "yarn") {
    execFileSync("yarn", ["install", "--no-lockfile"], { cwd: projectDir, stdio: "inherit", env });
  } else {
    execFileSync(
      "pnpm",
      [
        "install",
        "--no-frozen-lockfile",
        "--no-strict-peer-dependencies",
        "--config.minimumReleaseAge=0",
      ],
      { cwd: projectDir, stdio: "inherit", env: installEnv },
    );
  }
}
