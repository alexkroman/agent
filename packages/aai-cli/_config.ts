// Copyright 2025 the AAI authors. MIT license.
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { consola } from "consola";
import { z } from "zod";
import { unwrapCancel } from "./_ui.ts";
import { readJson, writeJson } from "./_utils.ts";

const ProjectConfigSchema = z.object({
  slug: z.string(),
  serverUrl: z.string(),
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
};

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
