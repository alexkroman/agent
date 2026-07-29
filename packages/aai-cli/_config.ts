// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { consola } from "consola";
import envPaths from "env-paths";
import { z } from "zod";
import { unwrapCancel } from "./_ui.ts";
import { readJson, writeJson } from "./_utils.ts";

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
  slug: z.string(),
  serverUrl: z.string(),
  sessionId: z.string().optional(),
});

/**
 * Config dir the CLI used before switching to env-paths. On Linux it matches
 * env-paths exactly; on macOS (XDG-style vs ~/Library/Preferences/aai) and
 * Windows (no trailing `Config` segment) it does not.
 */
function legacyConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "aai");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "aai");
}

/**
 * Resolve the global config directory, preferring the platform-conventional
 * env-paths location while staying backward compatible: an existing config at
 * the legacy path keeps winning so already-authenticated users are not
 * silently logged out. Injectable for tests.
 */
export function getConfigDir(
  dirs: { legacy: string; modern: string } = {
    legacy: legacyConfigDir(),
    modern: envPaths("aai", { suffix: "" }).config,
  },
  exists: (p: string) => boolean = existsSync,
): string {
  return exists(path.join(dirs.legacy, "config.json")) ? dirs.legacy : dirs.modern;
}

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  const file = path.join(agentDir, ".aai", "project.json");
  const parsed = ProjectConfigSchema.safeParse(await readJson(file));
  if (!parsed.success) {
    consola.debug(`Failed to read project config from ${file}:`, parsed.error);
    return null;
  }
  return parsed.data;
}

export async function writeProjectConfig(agentDir: string, data: ProjectConfig): Promise<void> {
  await writeJson(path.join(agentDir, ".aai", "project.json"), data);
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
  await writeJson(path.join(configDir, "config.json"), data);
}

export async function ensureApiKey(configDir?: string): Promise<string> {
  const dir = configDir ?? getConfigDir();
  const config = await readGlobalConfig(dir);
  if (config.apiKey) return config.apiKey;

  // Allow non-interactive usage (CI, Claude Code) via env var
  const envKey = process.env.ASSEMBLYAI_API_KEY;
  if (envKey) {
    await writeGlobalConfig(dir, { ...config, apiKey: envKey });
    return envKey;
  }

  const apiKey = unwrapCancel(await p.password({ message: "Enter your AssemblyAI API key" }));
  await writeGlobalConfig(dir, { ...config, apiKey });
  return apiKey;
}
