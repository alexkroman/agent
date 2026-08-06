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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@alexkroman1/aai";
import { scrubDir } from "./studio-build.ts";
import { ensureProjectShape, fileExists } from "./studio-project-shape.ts";
import {
  CLI_OUTPUT_CAP,
  parseLastJsonLine,
  pathOnlyEnv,
  runCapped,
  type SpawnCappedResult,
} from "./studio-spawn.ts";

/** Wall-clock cap for one `aai deploy` run (cold build + upload). */
const DEPLOY_TIMEOUT_MS = 300_000;

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
          if (await fileExists(candidate)) return candidate;
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

/** The CLI's one-line `--json` result (see aai-cli/_output.ts). */
type CliResult =
  | { ok: true; data: { slug: string; url: string; warnings?: string[] } }
  | { ok: false; error: string; code: string; hint?: string };

/**
 * Run `aai deploy` against a materialized workspace directory.
 *
 * The caller's API key lands in a dir-local AAI_CONFIG_DIR (the CLI's
 * config home), never in this process's env; `--server` approves the
 * platform origin the same way a user typing it would.
 */
export async function deployWorkspaceDir(
  dir: string,
  opts: {
    serverUrl: string;
    apiKey: string;
    slug?: string | undefined;
    /**
     * Opt into a `-preview`-suffixed slug. Set ONLY by the studio's
     * auto-preview deployer — never by Publish. See the flag's note below.
     */
    allowPreviewSlug?: boolean | undefined;
    /** Test seam: entry script spawned instead of the resolved CLI. */
    cliEntry?: string | undefined;
  },
): Promise<GuestPublishResult> {
  let cliEntry: string;
  try {
    cliEntry = opts.cliEntry ?? (await resolveCliEntry());
  } catch (err) {
    return {
      ok: false,
      output: `Publish toolchain unavailable in this sandbox: ${errorMessage(err)}`,
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

  let result: SpawnCappedResult;
  try {
    result = await runCapped(
      process.execPath,
      // `--allow-preview-slug` rides ONLY on the auto-preview deploy, which
      // deliberately targets `<project>-preview` — a suffix the deploy
      // boundary otherwise rejects because the orphan-preview reaper owns it.
      //
      // It must NOT ride on the shared invocation. Publish's slug comes from
      // the studio PROJECT name, and a CLI push derives that from the
      // directory (`projectNameFromDir`), so a project named `*-preview`
      // would claim a reserved slug through the one path users actually
      // take — and the hourly sweep would then delete the agent, its app
      // database, and its secrets. That is exactly the loss the guard exists
      // to prevent, so the opt-in is the CALLER's declaration of intent and
      // is never inferred from the slug's shape.
      [
        cliEntry,
        "deploy",
        "--server",
        opts.serverUrl,
        "--json",
        "--allow-missing-secrets",
        ...(opts.allowPreviewSlug ? ["--allow-preview-slug"] : []),
      ],
      {
        cwd: dir,
        env: { AAI_CONFIG_DIR: configHome, ...pathOnlyEnv() },
        timeoutMs: DEPLOY_TIMEOUT_MS,
        cap: CLI_OUTPUT_CAP,
      },
    );
    if (result.signal) {
      throw new Error(`aai deploy killed by ${result.signal} after ${DEPLOY_TIMEOUT_MS}ms`);
    }
  } catch (err) {
    return { ok: false, output: `aai deploy failed to run: ${errorMessage(err)}` };
  }

  const parsed = parseLastJsonLine<CliResult>(result.stdout);
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
