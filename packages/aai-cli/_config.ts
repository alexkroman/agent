// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import ci from "ci-info";
import { consola } from "consola";
import { z } from "zod";
import { CliError } from "./_output.ts";

const AuthConfigSchema = z.object({
  assemblyai_api_key: z.string().optional(),
});

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

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

type AuthConfig = z.infer<typeof AuthConfigSchema>;

async function readAuthConfig(): Promise<AuthConfig> {
  try {
    return AuthConfigSchema.parse(JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")));
  } catch (error) {
    consola.debug(`Failed to read auth config from ${CONFIG_FILE}:`, error);
    return {};
  }
}

async function writeAuthConfig(config: AuthConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  if (process.platform !== "win32") {
    await fs.chmod(CONFIG_FILE, 0o600);
  }
}

export async function getApiKey(): Promise<string> {
  if (process.env.ASSEMBLYAI_API_KEY) {
    return process.env.ASSEMBLYAI_API_KEY;
  }

  const config = await readAuthConfig();
  if (config.assemblyai_api_key) {
    return config.assemblyai_api_key;
  }

  if (ci.isCI || !process.stdin.isTTY) {
    throw new CliError(
      "auth_failed",
      "No ASSEMBLYAI_API_KEY found",
      "Set the ASSEMBLYAI_API_KEY environment variable",
    );
  }

  p.log.info("Get your API key at https://www.assemblyai.com/dashboard/signup");
  p.log.info("Or set the ASSEMBLYAI_API_KEY environment variable to skip this prompt.");

  let key: string | undefined;
  while (!key) {
    const result = await p.password({ message: "ASSEMBLYAI_API_KEY" });
    if (p.isCancel(result)) process.exit(0);
    key = result;
  }

  config.assemblyai_api_key = key;
  await writeAuthConfig(config);
  return key;
}

export async function ensureApiKeyInEnv(): Promise<string> {
  const key = await getApiKey();
  process.env.ASSEMBLYAI_API_KEY = key;
  return key;
}

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  try {
    return ProjectConfigSchema.parse(
      JSON.parse(await fs.readFile(path.join(agentDir, ".aai", "project.json"), "utf-8")),
    );
  } catch (error) {
    consola.debug(
      `Failed to read project config from ${path.join(agentDir, ".aai", "project.json")}:`,
      error,
    );
    return null;
  }
}

export async function writeProjectConfig(agentDir: string, data: ProjectConfig): Promise<void> {
  const aaiDir = path.join(agentDir, ".aai");
  await fs.mkdir(aaiDir, { recursive: true });
  await fs.writeFile(path.join(aaiDir, "project.json"), `${JSON.stringify(data, null, 2)}\n`);
}
