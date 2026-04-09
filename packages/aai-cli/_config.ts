// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
