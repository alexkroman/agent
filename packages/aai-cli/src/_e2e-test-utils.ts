// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared helpers for the e2e test suites (e2e*.test.ts): CLI build, mock
 * registry setup, dependency installation, and process/server utilities.
 * Each e2e suite performs its own setup/teardown using these helpers.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execaSync } from "execa";
import { ofetch } from "ofetch";
import type { MockRegistry } from "./_mock-registry.ts";

/**
 * This PACKAGE's root, not this module's own directory.
 *
 * Every use wants the package: the `pnpm run build` cwd, `dist/cli.*`,
 * `node_modules`, and the sibling-package fixture path in
 * `_e2e-browser-test-utils.ts`. It was `import.meta.dirname` and named `dir`
 * back when those were the same directory; the `src/` move made them differ
 * and the name is what hid it.
 */
const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
export const packageDir = path.resolve(here, "..");
export const packagesDir = path.resolve(packageDir, "..");

export const pm = (process.env.AAI_TEST_PM ?? "pnpm") as "pnpm" | "npm" | "yarn";

/**
 * The workspace packages this suite publishes to its mock registry — by
 * directory name under `packages/`, which is also their npm name minus the
 * scope.
 *
 * One list, because the two consumers have to agree: `startRegistry` publishes
 * these and `installDeps` rewrites exactly these dependencies to the version it
 * published them under. A package present in one and not the other installs
 * from the real npmjs, i.e. tests the released copy instead of this working
 * tree — silently.
 */
const PUBLISHED_PACKAGES = ["aai", "aai-runtime", "aai-ui", "aai-cli"] as const;
const PUBLISHED_DEP_NAMES: ReadonlySet<string> = new Set(
  PUBLISHED_PACKAGES.map((name) => `@alexkroman1/${name}`),
);

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
  if (_e2eConfigDir === undefined) {
    _e2eConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-config-"));
    // Seeded with a key, the way `aai login` would leave it: an exported
    // ASSEMBLYAI_API_KEY is no longer an authentication path, so the config
    // file is the only thing that can make a spawned CLI logged in.
    fs.writeFileSync(path.join(_e2eConfigDir, "config.json"), JSON.stringify({ apiKey: "test" }), {
      mode: 0o600,
    });
  }
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
    // A PROVIDER credential for the scaffolded project's own runtime (the
    // default pipeline is all-AssemblyAI), not authentication — the CLI
    // authenticates from AAI_CONFIG_DIR's config.json above and nowhere else.
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "test",
    // NOTE: `ignore-scripts` deliberately does NOT belong here — see
    // `installDeps`, which sets it for the install and nothing else.
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
 * {@link aai}, but CAPTURING and expecting the CLI to FAIL — for the cases
 * whose subject is what it SAID on its way to a non-zero exit.
 *
 * Capturing is separate from {@link aai} rather than a flag on it, because
 * `stdio: "inherit"` is load-bearing for every other call: an e2e failure's
 * only diagnosis trail is the child's output in the run log, and capturing it
 * by default would take that away.
 *
 * The exit code is asserted HERE rather than left to the caller. `execaSync`
 * throws on a non-zero exit, so the capturing helper this replaced could only
 * be pointed at commands that succeed — and a `try`/`catch` around it would
 * pass just as happily on a zero exit, which is the bug the one caller exists
 * to catch (`aai test` named its unrun specs and exited 0 anyway).
 */
export function aaiOutputFailing(
  aaiBin: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): { stdout: string; stderr: string; exitCode: number } {
  const res = execaSync(process.execPath, [aaiBin, ...args], {
    cwd,
    extendEnv: false,
    env: aaiEnv(),
    timeout: timeoutMs,
    reject: false,
  });
  const exitCode = res.exitCode ?? 0;
  if (exitCode === 0) {
    throw new Error(
      `Expected \`aai ${args.join(" ")}\` to fail, but it exited 0.\n${res.stdout ?? ""}`,
    );
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode };
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
  execaSync("pnpm", ["run", "build"], { cwd: packageDir, stdio: "inherit" });
  const mjs = path.resolve(packageDir, "dist/cli.mjs");
  const js = path.resolve(packageDir, "dist/cli.js");
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
  fs.symlinkSync(path.resolve(packageDir, "node_modules"), path.join(into, "node_modules"), "dir");
  return path.join(into, "dist", path.basename(aaiBin));
}

/**
 * Start a mock npm registry and publish workspace packages to it.
 * Packages are built + published inside startMockRegistry, so consumers
 * (npm/pnpm/yarn install) resolve them exactly as they would from the real registry.
 */
export async function startRegistry(): Promise<MockRegistry> {
  const { startMockRegistry } = await import("./_mock-registry.ts");
  return startMockRegistry(packagesDir, [...PUBLISHED_PACKAGES]);
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

/**
 * Run a scaffolded project the way a self-hoster does — `npm start`, which runs
 * the project's own `prestart` (`aai build`) and then `server.mjs`.
 *
 * Extracted because there are two legs now and the spawn is the fiddly half: the
 * port has to be read off stdout, and every way this can fail — a build error, a
 * missing artifact, a throwing agent — reports on STDERR, so both streams are
 * buffered and both go into the failure. Discarding stderr leaves a bare
 * "exited with code 1" naming none of them, which cost a full diagnosis cycle
 * once already.
 *
 * `PORT=0` lets the OS assign one: this suite runs servers concurrently and a
 * fixed port is an EADDRINUSE flake waiting to happen.
 */
export async function startSelfHostedServer(
  projectDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ url: string; port: number; stop: () => Promise<void>; output: () => string }> {
  const child = spawn("npm", ["start"], {
    cwd: projectDir,
    env: { ...aaiEnv(), PORT: "0", ...extraEnv },
    stdio: "pipe",
  });
  let buf = "";
  const collect = (chunk: Buffer) => {
    buf += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const stop = async () => {
    child.kill();
    await waitForExit(child);
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const check = () => {
        // The line server.mjs prints on listen: "<name> listening on <url>".
        const match = buf.match(/listening on http:\/\/[^:]+:(\d+)/);
        if (match) resolve(Number(match[1]));
      };
      child.stdout?.on("data", check);
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(
          new Error(`npm start exited with code ${code} before listening:\n${buf.slice(-4000)}`),
        ),
      );
    });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(`${url}/health`, child);
    return { url, port, stop, output: () => buf };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * Whether a failed install may be excused as the mock registry's npmjs
 * passthrough failing rather than as a real dependency-resolution break.
 *
 * **`AAI_REQUIRE_REGISTRY` turns every excuse off**, and CI sets it — the same
 * shape as `AAI_REQUIRE_PG`, for the same reason. A skip predicate over ERROR TEXT
 * is a guess, and this tier is where a broken `exports` map surfaces: with three
 * of four tests able to self-skip, a genuine break whose message happens to
 * contain a matched substring would report green in the one job that could have
 * caught it. Locally the excuse stays, because a developer behind a proxy has no
 * way to make the passthrough work and a hard failure there is just noise.
 *
 * The predicate itself is narrowed to TRANSPORT-level failures. `fetch failed`
 * and `network` are gone: both are substrings a real 404 can carry, which made
 * them the two patterns most likely to excuse the thing this suite exists to
 * find. verdaccio maps a failed upstream fetch to a plain 404, so
 * `ERR_PNPM_FETCH_*` on a THIRD-PARTY package still counts — but never one naming
 * our own scope, since those live in verdaccio's local storage and failing to
 * resolve one means the published packages are actually broken.
 */
export function isRegistryProxyFailure(err: unknown): boolean {
  if (/^(1|true|yes|on)$/i.test(process.env.AAI_REQUIRE_REGISTRY ?? "")) return false;
  const msg =
    err instanceof Error
      ? `${err.message}\n${(err as { stderr?: string }).stderr ?? ""}\n${(err as { stdout?: string }).stdout ?? ""}`
      : String(err);
  if (/@alexkroman1/i.test(msg) && /404|Not Found|ERR_PNPM_FETCH/i.test(msg)) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|407|502|503|504|ERR_PNPM_FETCH/i.test(
    msg,
  );
}

/**
 * Install dependencies using the mock registry.
 *
 * **`ignore-scripts` is set HERE and nowhere else, and that placement is
 * load-bearing.** It exists to stop a linked package's `postinstall` running
 * during THIS install — but `npm_config_ignore_scripts` is read by every npm
 * invocation, so while it sat in `aaiEnv()` it silently suppressed every
 * lifecycle script in every spawned command. That took out `npm start`'s
 * `prestart`, i.e. the build the self-hosted entrypoint cannot boot without: the
 * child printed `> start` with no `> prestart` above it and died on the missing
 * artifact, naming a project file rather than the env var that skipped the step.
 *
 * The trap generalizes past this repo — an install-time protection that is
 * really a global one — and the second half is worse than the failure: had the
 * artifact happened to exist from an earlier build, the test would have PASSED
 * while never running the script it exists to exercise.
 */
export function installDeps(registry: MockRegistry, projectDir: string): void {
  const env = { ...aaiEnv(), ...registry.env, npm_config_ignore_scripts: "true" };

  // Rewrite workspace dep versions to match the unique testVersion
  // published to the mock registry (avoids pnpm store cache collisions).
  const pkgJsonPath = path.join(projectDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  for (const depField of ["dependencies", "devDependencies"] as const) {
    if (!pkgJson[depField]) continue;
    for (const dep of Object.keys(pkgJson[depField])) {
      if (PUBLISHED_DEP_NAMES.has(dep)) pkgJson[depField][dep] = registry.testVersion;
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
