// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { consola } from "consola";
import { z } from "zod";

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

/** Write `data` as pretty-printed JSON, creating the parent directory if needed. */
async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  const file = path.join(agentDir, ".aai", "project.json");
  try {
    return ProjectConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf-8")));
  } catch (error) {
    consola.debug(`Failed to read project config from ${file}:`, error);
    return null;
  }
}

export async function writeProjectConfig(agentDir: string, data: ProjectConfig): Promise<void> {
  await writeJsonFile(path.join(agentDir, ".aai", "project.json"), data);
}

export type GlobalConfig = {
  apiKey?: string;
};

export async function readGlobalConfig(configDir?: string): Promise<GlobalConfig> {
  const dir = configDir ?? getConfigDir();
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")) as GlobalConfig;
  } catch {
    return {};
  }
}

export async function writeGlobalConfig(configDir: string, data: GlobalConfig): Promise<void> {
  await writeJsonFile(path.join(configDir, "config.json"), data);
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

  const result = await p.password({ message: "Enter your AssemblyAI API key" });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  await writeGlobalConfig(dir, { ...config, apiKey: result });
  return result;
}
