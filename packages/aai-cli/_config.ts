// Copyright 2025 the AAI authors. MIT license.
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { consola } from "consola";
import { z } from "zod";
import { unwrapCancel } from "./_ui.ts";
import { readJson, writeJson } from "./_utils.ts";

/**
 * `.aai/project.json` lives in the working tree, so everything in it is
 * untrusted input — a cloned repo can supply any value. `serverUrl` must at
 * minimum parse as an http(s) URL here; whether the CLI is willing to send a
 * credential there is decided separately (see `resolveServerUrl`).
 */
const ProjectConfigSchema = z.object({
  slug: z.string(),
  serverUrl: z.string().refine((raw) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }, "serverUrl must be an absolute http(s) URL"),
  sessionId: z.string().optional(),
});

export function getConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "aai");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "aai");
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

/** Origin of `url`, or `null` when it is not a valid absolute URL. */
export function serverOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
