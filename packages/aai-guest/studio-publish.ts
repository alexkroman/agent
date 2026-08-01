// Copyright 2026 the AAI authors. MIT license.
/**
 * Guest-side Publish — runs THE aai CLI's `deploy` command in this sandbox.
 *
 * The studio's Publish button is `aai deploy`, literally: the workspace is
 * materialized like a project, a config home carries the caller's own API
 * key, and the toolchain's CLI entry is spawned with `--server <origin>
 * --json --allow-missing-secrets`. Building, config extraction, ownership,
 * reserved slugs, the ASSEMBLYAI_API_KEY floor, and the credential
 * preflight all happen exactly as they do for a laptop deploy — one path.
 * The CLI's output (success, build diagnostics, deploy errors, warnings)
 * is returned verbatim-ish for the chat, so the coding agent can act on
 * failures.
 *
 * `--allow-missing-secrets` because the studio's Secrets panel needs a
 * DEPLOYED slug to attach secrets to — a hard preflight failure would
 * deadlock first publishes of agents that need third-party keys.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubDir } from "./studio-build.ts";
import { ensureProjectShape } from "./studio-project-shape.ts";

/** Wall-clock cap for one `aai deploy` run (cold build + upload). */
const DEPLOY_TIMEOUT_MS = 300_000;
/** Output tail kept per stream. */
const OUTPUT_CAP = 32_000;

export type GuestPublishResult = {
  ok: boolean;
  slug?: string;
  url?: string;
  /** CLI output for the chat — success summary, or the failure diagnostics. */
  output: string;
};

/**
 * Resolve the aai CLI's executable entry from the toolchain next to the
 * harness: package root via a resolvable subpath, then its `bin` map (a
 * plain file in dev, `dist/cli.mjs` in the published package).
 */
export async function resolveCliEntry(): Promise<string> {
  // worker-bundler is an exported subpath in both layouts; package.json is
  // not — and the exports map declares import-conditions only, so this must
  // be import.meta.resolve, not createRequire().resolve.
  const resolved = fileURLToPath(import.meta.resolve("@alexkroman1/aai-cli/worker-bundler"));
  let dir = path.dirname(resolved);
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as {
        name?: string;
        bin?: string | Record<string, string>;
        publishConfig?: { bin?: string | Record<string, string> };
      };
      if (pkg.name === "@alexkroman1/aai-cli") {
        // The published bin (`dist/cli.mjs`, from publishConfig) first: the
        // workspace-dev `bin.mjs` shim imports TypeScript source, which only
        // Node ≥ 24 can run directly. In the published package the two agree.
        const candidates = [pkg.publishConfig?.bin, pkg.bin]
          .map((bin) => (typeof bin === "string" ? bin : bin?.aai))
          .filter((bin): bin is string => Boolean(bin))
          .map((bin) => path.join(dir, bin));
        for (const candidate of candidates) {
          if (await exists(candidate)) return candidate;
        }
        throw new Error(`@alexkroman1/aai-cli's bin entry is missing (tried ${candidates.length})`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate @alexkroman1/aai-cli's package root");
}

/** Run one child process, capturing capped output tails. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, timeout: DEPLOY_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    const keep = (s: string) => (s.length > OUTPUT_CAP ? `…${s.slice(-OUTPUT_CAP)}` : s);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keep(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keep(stderr + chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`aai deploy killed by ${signal} after ${DEPLOY_TIMEOUT_MS}ms`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/** The CLI's one-line `--json` result (see aai-cli/_output.ts). */
type CliResult =
  | { ok: true; data: { slug: string; url: string; warnings?: string[] } }
  | { ok: false; error: string; code: string; hint?: string };

function parseCliResult(stdout: string): CliResult | null {
  const line = stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as CliResult;
  } catch {
    return null;
  }
}

/**
 * Run `aai deploy` against a materialized workspace directory.
 *
 * The caller's API key lands in a dir-local AAI_CONFIG_DIR (the CLI's
 * config home), never in this process's env; `--server` approves the
 * platform origin the same way a user typing it would.
 */
export async function deployWorkspaceDir(
  dir: string,
  opts: { serverUrl: string; apiKey: string; slug?: string | undefined },
): Promise<GuestPublishResult> {
  let cliEntry: string;
  try {
    cliEntry = await resolveCliEntry();
  } catch (err) {
    return {
      ok: false,
      output: `Publish toolchain unavailable in this sandbox: ${errMessage(err)}`,
    };
  }

  // A real project's shape (package.json, tsconfig, vite config — see
  // studio-project-shape.ts; `aai deploy` typechecks against the tsconfig),
  // the CLI's config home, and the slug pin in .aai/project.json so
  // redeploys keep the agent's URL.
  await ensureProjectShape(dir);
  const configHome = path.join(dir, ".aai-home");
  await mkdir(configHome, { recursive: true });
  await writeFile(path.join(configHome, "config.json"), JSON.stringify({ apiKey: opts.apiKey }), {
    mode: 0o600,
  });
  if (opts.slug) {
    await mkdir(path.join(dir, ".aai"), { recursive: true });
    await writeFile(
      path.join(dir, ".aai", "project.json"),
      JSON.stringify({ slug: opts.slug, serverUrl: opts.serverUrl }),
      "utf-8",
    );
  }

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(
      process.execPath,
      [cliEntry, "deploy", "--server", opts.serverUrl, "--json", "--allow-missing-secrets"],
      {
        cwd: dir,
        env: {
          AAI_CONFIG_DIR: configHome,
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        },
      },
    );
  } catch (err) {
    return { ok: false, output: `aai deploy failed to run: ${errMessage(err)}` };
  }

  const parsed = parseCliResult(result.stdout);
  const stderrTail = result.stderr.trim();
  if (parsed?.ok) {
    const warnings = parsed.data.warnings ?? [];
    const output = [
      `Deployed ${parsed.data.url}`,
      `slug: ${parsed.data.slug}`,
      ...warnings.map((w) => `warning: ${w}`),
    ].join("\n");
    return {
      ok: true,
      slug: parsed.data.slug,
      url: parsed.data.url,
      output: scrubDir(output, dir),
    };
  }
  if (parsed) {
    const output = [parsed.error, ...(parsed.hint ? [parsed.hint] : [])].join("\n");
    return { ok: false, output: scrubDir(output, dir) };
  }
  // No parsable result — the CLI died before reporting; surface everything.
  return {
    ok: false,
    output: scrubDir(
      `aai deploy exited with ${result.exitCode}\n${result.stdout.trim()}\n${stderrTail}`.trim(),
      dir,
    ),
  };
}

async function exists(p: string): Promise<boolean> {
  return await readFile(p, "utf-8").then(
    () => true,
    () => false,
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
