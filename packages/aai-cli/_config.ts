// Copyright 2025 the AAI authors. MIT license.
import path from "node:path";
import * as p from "@clack/prompts";
import envPaths from "env-paths";
import { z } from "zod";
import { CliError } from "./_output.ts";
import { log, unwrapCancel } from "./_ui.ts";
import { errorMessage, readJson, writeJson } from "./_utils.ts";

/**
 * `.aai/project.json` lives in the working tree, so everything in it is
 * untrusted input — a cloned repo can supply any value.
 *
 * `serverUrl` is deliberately NOT validated here. A failed field makes
 * `readProjectConfig` return null for the whole file, which discards the
 * `slug` too — and a deploy with no slug generates a fresh one, silently
 * creating a duplicate agent and overwriting the config. The URL is instead
 * validated where it is used, by `resolveServerUrl`, which rejects anything
 * that isn't an approved http(s) origin.
 */
const ProjectConfigSchema = z.object({
  /** Deployed agent slug — absent for a pulled project never published. */
  slug: z.string().optional(),
  serverUrl: z.string(),
  /** Studio project this directory is linked to (`aai pull`/`aai push`). */
  studioProject: z.string().optional(),
  /**
   * The workspace files hash at the last pull/push — `aai push` sends it
   * back as the fast-forward token, so an edit made in the studio since
   * then surfaces as a 409 instead of being silently overwritten.
   */
  studioSourceHash: z.string().optional(),
});

/**
 * Resolve the global config directory (the platform-conventional env-paths
 * location).
 *
 * `AAI_CONFIG_DIR` overrides everything — it exists so tests (and unusual
 * setups) can redirect ALL global-config reads and writes away from the
 * user's real config. The test suite's `approveServer` calls used to
 * permanently pollute `~/.config/aai/config.json` with approved origins.
 */
export function getConfigDir(): string {
  const override = process.env.AAI_CONFIG_DIR?.trim();
  if (override) return override;
  return envPaths("aai", { suffix: "" }).config;
}

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  const file = path.join(agentDir, ".aai", "project.json");
  let data: unknown;
  try {
    data = await readJson(file);
  } catch (err) {
    // A corrupted project.json must not read as "never deployed": a deploy
    // with no slug generates a fresh one, orphaning the live deployment.
    const reason = errorMessage(err).replace(`Invalid JSON in ${file}: `, "");
    throw new Error(
      `project.json is corrupted at ${file}: ${reason}\n` +
        "  Fix or delete the file — deploying without it would create a new agent under a fresh slug.",
      { cause: err },
    );
  }
  if (data === null) return null;
  const parsed = ProjectConfigSchema.safeParse(data);
  // Schema failure reads as "never deployed" (see the schema doc comment) —
  // deliberately quiet, since the URL is trust-checked where it is used.
  if (!parsed.success) return null;
  return parsed.data;
}

export async function writeProjectConfig(agentDir: string, data: ProjectConfig): Promise<void> {
  await writeJson(path.join(agentDir, ".aai", "project.json"), data);
}

/**
 * Merge `patch` into the existing project config rather than replacing the
 * file — a publish recording its `slug` must not drop the studio link
 * fields a pull wrote, and vice versa.
 */
export async function updateProjectConfig(
  agentDir: string,
  patch: Partial<ProjectConfig> & Pick<ProjectConfig, "serverUrl">,
): Promise<ProjectConfig> {
  let existing: ProjectConfig | null = null;
  try {
    existing = await readProjectConfig(agentDir);
  } catch {
    // Corrupted file: the patch's full values replace it (the read-throw
    // exists to protect DEPLOY from minting a fresh slug, not updates that
    // carry their own slug/link state).
  }
  const merged = { ...existing, ...patch };
  await writeProjectConfig(agentDir, merged);
  return merged;
}

export type GlobalConfig = {
  apiKey?: string;
  /**
   * Origins the user has explicitly pointed the CLI at with `--server`.
   *
   * Lives in the user-owned global config, never in the repo: it is what makes
   * a `serverUrl` from `.aai/project.json` trustworthy enough to receive an
   * API key. See `resolveServerUrl`.
   */
  approvedServers?: string[];
};

/**
 * Origin of `url`, or `null` when it is not an absolute http(s) URL.
 *
 * Non-HTTP schemes are rejected rather than returned: `new URL()` yields the
 * opaque origin `"null"` for them, which would otherwise flow on as if it
 * were a real origin.
 */
export function serverOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/**
 * Record `url`'s origin as user-approved, so later commands in this project
 * may send credentials there without re-passing `--server`.
 */
export async function approveServer(url: string, configDir?: string): Promise<void> {
  const origin = serverOrigin(url);
  if (!origin) return;
  const dir = configDir ?? getConfigDir();
  const config = await readGlobalConfig(dir);
  const approved = config.approvedServers ?? [];
  if (approved.includes(origin)) return;
  await writeGlobalConfig(dir, { ...config, approvedServers: [...approved, origin] });
}

export async function readGlobalConfig(configDir?: string): Promise<GlobalConfig> {
  const dir = configDir ?? getConfigDir();
  return ((await readJson(path.join(dir, "config.json"))) as GlobalConfig | null) ?? {};
}

export async function writeGlobalConfig(configDir: string, data: GlobalConfig): Promise<void> {
  // config.json holds the plaintext API key — owner-only, like ~/.aws or
  // ~/.npmrc. The mode rides the atomic-rename temp file, so an existing
  // world-readable config from an older CLI is tightened on the next write.
  await writeJson(path.join(configDir, "config.json"), data, { mode: 0o600 });
}

/**
 * Persist the API key to the global config, warning (not failing) when the
 * config dir is unwritable — the key in hand still works for this run.
 */
async function trySaveApiKey(dir: string, config: GlobalConfig, apiKey: string): Promise<void> {
  try {
    await writeGlobalConfig(dir, { ...config, apiKey });
  } catch (err) {
    log.warn(
      `Couldn't save your API key to ${path.join(dir, "config.json")}: ${errorMessage(err)} — ` +
        "you'll be prompted again next run.",
    );
  }
}

export async function ensureApiKey(configDir?: string): Promise<string> {
  const dir = configDir ?? getConfigDir();
  const config = await readGlobalConfig(dir);
  if (config.apiKey) return config.apiKey;

  // Allow non-interactive usage (CI, Claude Code) via env var
  const envKey = process.env.ASSEMBLYAI_API_KEY;
  if (envKey) {
    await trySaveApiKey(dir, config, envKey);
    return envKey;
  }

  // Without a TTY there is nobody to answer the prompt — and worse, the
  // hidden password prompt would consume piped stdin as keystrokes (e.g.
  // eating the secret value in `echo "$SECRET" | aai secret put NAME --json`)
  // and hang, or persist that stray input as the API key. Fail fast instead.
  if (!process.stdin.isTTY) {
    throw new CliError(
      "no_api_key",
      "No API key configured and no TTY to prompt for one.",
      "Set the ASSEMBLYAI_API_KEY environment variable, or run `aai login` interactively once to save a key.",
    );
  }

  const apiKey = unwrapCancel(
    await p.password({ message: "Enter your AssemblyAI API key" }),
    "Setup cancelled",
  );
  await trySaveApiKey(dir, config, apiKey);
  return apiKey;
}
